/**
 * Portal verification API (identity: portal). The existing account portal
 * calls these after the person signs in to the existing IdP with MFA (spec
 * section 7 "Preferred verification journey"):
 *
 *  - describe: shows the two-word match code for the secure-link transaction;
 *    the URL fragment nonce never reaches the gateway in a URL (POST body only);
 *  - approve: binds the account to exactly the call session and generation of the
 *    transaction (nonce + ID token + explicit match-code confirmation, strict boolean);
 *  - step-up: A3 for one prepared-action digest (fresh IdP authentication).
 *
 * Unknown, consumed, expired, ineligible and nonce-mismatched transactions are
 * indistinguishable (404 VERIFICATION_TRANSACTION_UNAVAILABLE). ID tokens and
 * nonces are never logged, audited or echoed.
 */
import { z } from "zod";
import { SESSION_AUDIT_ACTIONS } from "../../business/contract.js";
import type { VerificationService } from "../../identity/ports.js";
import type { IntegrationIdentity } from "../../protocol/index.js";
import { IsoDateTime } from "../../protocol/index.js";
import { AccessDeniedError } from "../../shared/errors.js";
import type { GatewayAudit } from "../gateway-audit.js";
import { AUTH_ERRORS, ErrorBody, defineRoute } from "./route.js";
import type { RouteDef } from "./route.js";

const TransactionId = z.string().regex(/^vtx_[A-Za-z0-9_-]{16,64}$/);
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const IdToken = z.string().min(16).max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const DescribeBody = z.strictObject({ transactionId: TransactionId, nonce: Nonce });
export const DescribeResponse = z.strictObject({ kind: z.enum(["secure_link", "step_up"]), matchCode: z.string().max(64).nullable(), expiresAt: IsoDateTime });
export const ApproveBody = z.strictObject({ transactionId: TransactionId, nonce: Nonce, idToken: IdToken, matchCodeConfirmed: z.boolean() });
export const StepUpBody = z.strictObject({ transactionId: TransactionId, nonce: Nonce, idToken: IdToken });
export const BindResponse = z.strictObject({ bound: z.boolean(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) });

export interface PortalRouteDeps {
  tenantId: string;
  verification: VerificationService & {
    describeTransaction(input: { transactionId: string; nonce: string }, integration: IntegrationIdentity): Promise<{ kind: "secure_link" | "step_up"; matchCode: string | null; expiresAt: string }>;
  };
  audit: GatewayAudit;
}

export function portalRoutes(d: PortalRouteDeps): RouteDef<unknown, unknown>[] {
  const bindAudit = async (bound: boolean, reasonCode: string, requestId: string, kind: "secure_link" | "step_up") =>
    d.audit.record({
      tenantId: d.tenantId,
      action: bound ? SESSION_AUDIT_ACTIONS.verificationBound : SESSION_AUDIT_ACTIONS.verificationFailed,
      outcome: bound ? "SUCCEEDED" : "DENIED",
      sourceComponent: "identity",
      reasonCode: bound ? (kind === "step_up" ? "STEP_UP_BOUND" : "SECURE_LINK_BOUND") : reasonCode,
      correlationId: requestId,
    });
  const safeCode = (c: string) => (/^[A-Z][A-Z0-9_]{2,63}$/.test(c) ? c : "VERIFICATION_NOT_BOUND");

  return [
    defineRoute({
      operationId: "portal.describeVerification",
      method: "POST",
      path: "/portal/v1/verification/describe",
      channel: "portal",
      summary: "Match code for a pending secure-link or step-up transaction (portal channel only).",
      tags: ["portal"],
      body: DescribeBody,
      responses: { 200: { description: "Transaction description", schema: DescribeResponse }, 404: { description: "Transaction unavailable (indistinguishable reasons)", schema: ErrorBody }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        try {
          const r = await d.verification.describeTransaction({ transactionId: ctx.body.transactionId, nonce: ctx.body.nonce }, ctx.integration as IntegrationIdentity);
          return { status: 200, body: { kind: r.kind, matchCode: r.matchCode, expiresAt: r.expiresAt } };
        } catch (err) {
          if (err instanceof AccessDeniedError) return { status: 404, body: { error: { reasonCode: "VERIFICATION_TRANSACTION_UNAVAILABLE", requestId: ctx.requestId } } };
          throw err;
        }
      },
    }),
    defineRoute({
      operationId: "portal.approveVerification",
      method: "POST",
      path: "/portal/v1/verification/approve",
      channel: "portal",
      summary: "Bind the MFA-authenticated account (OIDC ID token, nonce, explicit match-code confirmation) to exactly the call session and generation of the transaction.",
      tags: ["portal"],
      body: ApproveBody,
      responses: { 200: { description: "Binding result", schema: BindResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const r = await d.verification.completeSecureLink({ transactionId: ctx.body.transactionId, nonce: ctx.body.nonce, idToken: ctx.body.idToken, matchCodeConfirmed: ctx.body.matchCodeConfirmed === true });
        const reasonCode = safeCode(r.reasonCode);
        await bindAudit(r.bound, reasonCode, ctx.requestId, "secure_link");
        return { status: 200, body: { bound: r.bound, reasonCode } };
      },
    }),
    defineRoute({
      operationId: "portal.approveStepUp",
      method: "POST",
      path: "/portal/v1/verification/step-up",
      channel: "portal",
      summary: "A3 step-up for exactly one prepared-action digest (fresh IdP authentication; session-wide assurance unchanged).",
      tags: ["portal"],
      body: StepUpBody,
      responses: { 200: { description: "Step-up result", schema: BindResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const r = await d.verification.completeStepUp({ transactionId: ctx.body.transactionId, nonce: ctx.body.nonce, idToken: ctx.body.idToken });
        const reasonCode = safeCode(r.reasonCode);
        await bindAudit(r.bound, reasonCode, ctx.requestId, "step_up");
        return { status: 200, body: { bound: r.bound, reasonCode } };
      },
    }),
  ] as RouteDef<unknown, unknown>[];
}
