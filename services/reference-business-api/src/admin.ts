/**
 * Fault-control API of the reference business API (WP-23): local and ci ONLY.
 *
 * Exists only when REFBIZ_FAULT_CONTROL=enabled in a local/ci environment (config.ts refuses anything else at
 * start-up) and binds the loopback interface. It provisions SYNTHETIC test tenants and drives the seams the
 * Layer-2 suites need; it never exists in a deployed composition (sandbox, staging, production):
 *
 *   POST   /__admin/accounts                              a new account (tenant instance): region, dialect,
 *                                                         time zone, documented visibility window, lookup lag
 *   POST   /__admin/accounts/{id}/clients                 an OAuth client with a scope set (secret returned once)
 *   POST   /__admin/accounts/{id}/seed                    synthetic records
 *   POST   /__admin/tls/hosts                             a server certificate for one host name (SNI)
 *   POST   /__admin/endpoints  | GET/PUT/DELETE .../{id}  dedicated loopback endpoints and their connection mode
 *   POST   /__admin/accounts/{id}/faults | GET | DELETE   HTTP-level faults (faults.ts) with hit counters
 *   POST   /__admin/accounts/{id}/barriers | GET          commit barriers (CONCURRENT_SAME_ACCOUNT seam)
 *   POST   /__admin/accounts/{id}/slots/{slotId}/touch    another channel changes a slot's version
 *   GET    /__admin/accounts/{id}/effects                 the append-only effect log
 *   GET    /__admin/accounts/{id}/requests                the request log (operation, request id, status)
 *   GET    /__admin/accounts/{id}/change-requests/{rid}   a change request regardless of visibility
 *   GET    /__admin/accounts/{id}/legacy-references/{ref} a legacy reference's reservation / fence state
 *   DELETE /__admin/accounts/{id}                         forget the account's faults, barriers and request log
 *   GET    /__admin/build                                 the code digest of the running service (build.ts)
 *
 * Every request must name the loopback interface in its Host header (127.0.0.1, localhost or [::1]): a page in a
 * local browser that rebinds a public name to 127.0.0.1 cannot reach this listener (DNS rebinding), and is refused
 * 421 HOST_REFUSED before any handler runs.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "./auth.js";
import { SCOPES } from "./auth.js";
import type { Store } from "./db.js";
import { ApiError } from "./errors.js";
import type { FaultBoard } from "./faults.js";
import { HTTP_FAULT_KINDS } from "./faults.js";
import { newId, OPAQUE_ID } from "./ids.js";
import type { EndpointPool, SniContexts } from "./listeners.js";

const Id = z.string().regex(OPAQUE_ID);
/** Host headers of the loopback interface only (DNS-rebinding guard). */
export const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/;
const Instant = z.iso.datetime({ offset: true });
const Day = z.iso.date();
const Version = z.number().int().min(1).max(1_000_000).default(1);

const AccountInput = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$|^local$/).default("us-east-1"),
  dialect: z.enum(["canonical", "legacy_codes"]).default("canonical"),
  timeZone: z.string().regex(/^(UTC|[A-Za-z_]{2,30}(\/[A-Za-z0-9_+-]{2,30}){1,2})$/).default("America/New_York"),
  visibilityWindowMs: z.number().int().min(0).max(600_000).default(2_000),
  lookupLagMs: z.number().int().min(0).max(600_000).default(0),
});

const SeedInput = z.strictObject({
  subjects: z.array(Id).max(200).default([]),
  providers: z.array(z.strictObject({ providerId: Id, displayName: z.string().min(1).max(80), practiceId: Id.nullable().default(null) })).max(100).default([]),
  slots: z
    .array(z.strictObject({ slotId: Id, providerId: Id, startsAt: Instant, timeZone: z.string().max(64), modality: z.enum(["video", "in_person", "phone"]), state: z.enum(["OPEN", "BOOKED", "BLOCKED"]).default("OPEN"), version: Version }))
    .max(500)
    .default([]),
  appointments: z
    .array(
      z.strictObject({
        appointmentId: Id,
        subjectId: Id,
        providerId: Id,
        slotId: Id.nullable(),
        startsAt: Instant,
        timeZone: z.string().max(64),
        modality: z.enum(["video", "in_person", "phone"]),
        status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]).default("SCHEDULED"),
        version: Version,
        visitReason: z.string().max(200).nullable().default(null),
      }),
    )
    .max(500)
    .default([]),
  invoices: z
    .array(
      z.strictObject({
        invoiceId: Id,
        subjectId: Id,
        issuedOn: Day,
        dueOn: Day,
        status: z.enum(["OPEN", "PAID", "IN_REVIEW", "VOID"]),
        balanceMinor: z.number().int(),
        version: Version,
        lines: z.array(z.strictObject({ lineId: Id, code: z.enum(["SESSION_FEE", "LATE_CANCELLATION", "NO_SHOW", "ADJUSTMENT", "PAYMENT"]), serviceDate: Day, amountMinor: z.number().int() })).max(50).default([]),
        payments: z
          .array(z.strictObject({ paymentId: Id, amountMinor: z.number().int().min(1), receivedAt: Instant, method: z.enum(["CARD", "ACH", "CHECK", "PORTAL"]), cardLast4: z.string().regex(/^\d{4}$/).nullable().default(null) }))
          .max(50)
          .default([]),
      }),
    )
    .max(200)
    .default([]),
  claims: z
    .array(
      z.strictObject({
        claimId: Id,
        subjectId: Id,
        serviceDate: Day,
        payerDisplayName: z.string().min(1).max(80),
        insurerStatus: z.enum(["RECEIVED", "IN_PROCESS", "ADJUDICATED_PAID", "ADJUDICATED_DENIED", "NEEDS_INFORMATION"]),
        statusAsOf: Instant,
        diagnosisCodes: z.string().max(80).nullable().default(null),
      }),
    )
    .max(200)
    .default([]),
  onboarding: z
    .array(
      z.strictObject({
        providerId: Id,
        stage: z.enum(["APPLICATION_RECEIVED", "DOCUMENTS_PENDING", "CREDENTIALING_IN_REVIEW", "CONTRACTING", "ACTIVE", "ON_HOLD"]),
        asOf: Instant,
        organizationId: Id.nullable().default(null),
        documents: z
          .array(z.strictObject({ documentType: z.enum(["LICENSE", "MALPRACTICE_INSURANCE", "W9", "DEA", "BOARD_CERTIFICATION"]), status: z.enum(["RECEIVED", "MISSING", "EXPIRED", "IN_REVIEW", "ACCEPTED"]), updatedAt: Instant }))
          .max(10)
          .default([]),
      }),
    )
    .max(100)
    .default([]),
  remittances: z
    .array(
      z.strictObject({
        remittanceId: Id,
        practiceId: Id,
        periodStart: Day,
        periodEnd: Day,
        totalMinor: z.number().int(),
        status: z.enum(["SCHEDULED", "SENT", "RETURNED"]),
        paidOn: Day.nullable().default(null),
        bankAccountLast4: z.string().regex(/^\d{4}$/).nullable().default(null),
      }),
    )
    .max(200)
    .default([]),
  referrals: z
    .array(
      z.strictObject({
        referralId: Id,
        subjectId: Id,
        specialtyCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
        status: z.enum(["RECEIVED", "IN_REVIEW", "ACCEPTED", "DECLINED", "SCHEDULED", "CLOSED"]),
        statusAsOf: Instant,
        receivedOn: Day,
        referringOrganizationId: Id.nullable().default(null),
        clinicalSummary: z.string().max(200).nullable().default(null),
      }),
    )
    .max(200)
    .default([]),
  authorizations: z
    .array(
      z.strictObject({
        authorizationId: Id,
        subjectId: Id,
        payerDisplayName: z.string().min(1).max(80),
        serviceCode: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,20}$/),
        status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED"]),
        unitsApproved: z.number().int().min(0).nullable().default(null),
        unitsUsed: z.number().int().min(0).nullable().default(null),
        validFrom: Day.nullable().default(null),
        validTo: Day.nullable().default(null),
        statusAsOf: Instant,
      }),
    )
    .max(200)
    .default([]),
  eligibility: z
    .array(
      z.strictObject({
        subjectId: Id,
        payerDisplayName: z.string().min(1).max(80),
        coverageStatus: z.enum(["ACTIVE", "INACTIVE", "NOT_FOUND_AT_PAYER"]),
        verifiedAt: Instant,
        memberReference: z.string().max(40).nullable().default(null),
      }),
    )
    .max(200)
    .default([]),
});

const FaultInput = z.strictObject({
  operation: z.string().regex(/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/),
  kind: z.enum(HTTP_FAULT_KINDS),
  delayMs: z.number().int().min(0).max(120_000).nullable().optional(),
  status: z.number().int().min(500).max(599).nullable().optional(),
  retryAfterSeconds: z.number().int().min(0).max(3_600).nullable().optional(),
  lagMs: z.number().int().min(0).max(600_000).nullable().optional(),
  resourceId: Id.nullable().optional(),
  afterReads: z.number().int().min(1).max(100).nullable().optional(),
  times: z.number().int().min(1).max(1_000).nullable().optional(),
});

const BarrierInput = z.strictObject({ operation: z.string().regex(/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/), resourceId: Id, parties: z.number().int().min(2).max(10), timeoutMs: z.number().int().min(100).max(60_000) });

export interface AdminDeps {
  /** The running service's code digest (build.ts), or null when it cannot be computed (compiled image). */
  codeDigest: string | null;
  store: Store;
  auth: Auth;
  faults: FaultBoard;
  sni: SniContexts;
  endpoints: EndpointPool;
}

function body<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new ApiError(400, "REQUEST_INVALID");
  return r.data;
}

async function accountExists(store: Store, accountId: string): Promise<void> {
  if ((await store.query("select 1 from refbiz.accounts where account_id = $1", [accountId])).length === 0) throw new ApiError(404, "NOT_FOUND");
}

export function buildAdminApp(deps: AdminDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  const { store, faults } = deps;
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    return reply.code(typeof status === "number" && status < 500 ? 400 : 500).send({ error: typeof status === "number" && status < 500 ? "REQUEST_INVALID" : "INTERNAL" });
  });
  const P = (v: unknown) => body(z.object({ accountId: Id }).loose(), v).accountId;
  app.addHook("onRequest", async (req, reply) => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) return reply.code(421).send({ error: "HOST_REFUSED" });
  });

  app.get("/__admin/health", async () => ({ status: "ok" }));
  app.get("/__admin/build", async () => ({ codeDigest: deps.codeDigest }));

  app.post("/__admin/accounts", async (req) => {
    const a = body(AccountInput, req.body);
    if (a.lookupLagMs > a.visibilityWindowMs) throw new ApiError(400, "LAG_EXCEEDS_DOCUMENTED_WINDOW");
    const accountId = newId("acc");
    await store.query("insert into refbiz.accounts (account_id, region, dialect, time_zone, visibility_window_ms, lookup_lag_ms) values ($1, $2, $3, $4, $5, $6)", [
      accountId,
      a.region,
      a.dialect,
      a.timeZone,
      a.visibilityWindowMs,
      a.lookupLagMs,
    ]);
    return { accountId, ...a };
  });

  app.post("/__admin/accounts/:accountId/clients", async (req) => {
    const accountId = P(req.params);
    await accountExists(store, accountId);
    const { scopes } = body(z.strictObject({ scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length) }), req.body);
    return deps.auth.registerClient(accountId, scopes);
  });

  app.post("/__admin/accounts/:accountId/seed", async (req) => {
    const accountId = P(req.params);
    await accountExists(store, accountId);
    const s = body(SeedInput, req.body);
    await store.tx(async (tx) => {
      for (const id of s.subjects) await tx.query("insert into refbiz.subjects (account_id, subject_id) values ($1, $2)", [accountId, id]);
      for (const p of s.providers) await tx.query("insert into refbiz.providers (account_id, provider_id, display_name, practice_id) values ($1, $2, $3, $4)", [accountId, p.providerId, p.displayName, p.practiceId]);
      for (const x of s.slots) {
        await tx.query("insert into refbiz.slots (account_id, slot_id, provider_id, starts_at, time_zone, modality, state, version) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
          accountId,
          x.slotId,
          x.providerId,
          x.startsAt,
          x.timeZone,
          x.modality,
          x.state,
          x.version,
        ]);
      }
      for (const a of s.appointments) {
        await tx.query(
          `insert into refbiz.appointments (account_id, appointment_id, subject_id, provider_id, slot_id, starts_at, time_zone, modality, status, version, visit_reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [accountId, a.appointmentId, a.subjectId, a.providerId, a.slotId, a.startsAt, a.timeZone, a.modality, a.status, a.version, a.visitReason],
        );
      }
      for (const i of s.invoices) {
        await tx.query("insert into refbiz.invoices (account_id, invoice_id, subject_id, issued_on, due_on, status, balance_minor, currency, version) values ($1, $2, $3, $4, $5, $6, $7, 'USD', $8)", [
          accountId,
          i.invoiceId,
          i.subjectId,
          i.issuedOn,
          i.dueOn,
          i.status,
          i.balanceMinor,
          i.version,
        ]);
        for (const l of i.lines) await tx.query("insert into refbiz.invoice_lines (account_id, invoice_id, line_id, code, service_date, amount_minor) values ($1, $2, $3, $4, $5, $6)", [accountId, i.invoiceId, l.lineId, l.code, l.serviceDate, l.amountMinor]);
        for (const p of i.payments) {
          await tx.query("insert into refbiz.payments (account_id, payment_id, invoice_id, amount_minor, received_at, method_code, card_last4) values ($1, $2, $3, $4, $5, $6, $7)", [
            accountId,
            p.paymentId,
            i.invoiceId,
            p.amountMinor,
            p.receivedAt,
            p.method,
            p.cardLast4,
          ]);
        }
      }
      for (const c of s.claims) {
        await tx.query("insert into refbiz.claims (account_id, claim_id, subject_id, service_date, payer_display_name, insurer_status, status_as_of, diagnosis_codes) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
          accountId,
          c.claimId,
          c.subjectId,
          c.serviceDate,
          c.payerDisplayName,
          c.insurerStatus,
          c.statusAsOf,
          c.diagnosisCodes,
        ]);
      }
      for (const o of s.onboarding) {
        await tx.query("insert into refbiz.onboarding (account_id, provider_id, stage, as_of, organization_id) values ($1, $2, $3, $4, $5)", [accountId, o.providerId, o.stage, o.asOf, o.organizationId]);
        for (const d of o.documents) await tx.query("insert into refbiz.onboarding_documents (account_id, provider_id, document_type, status, updated_at) values ($1, $2, $3, $4, $5)", [accountId, o.providerId, d.documentType, d.status, d.updatedAt]);
      }
      for (const r of s.remittances) {
        await tx.query("insert into refbiz.remittances (account_id, remittance_id, practice_id, period_start, period_end, total_minor, status, paid_on, bank_account_last4) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          accountId,
          r.remittanceId,
          r.practiceId,
          r.periodStart,
          r.periodEnd,
          r.totalMinor,
          r.status,
          r.paidOn,
          r.bankAccountLast4,
        ]);
      }
      for (const r of s.referrals) {
        await tx.query(
          "insert into refbiz.referrals (account_id, referral_id, subject_id, specialty_code, status, status_as_of, received_on, referring_organization_id, clinical_summary) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [accountId, r.referralId, r.subjectId, r.specialtyCode, r.status, r.statusAsOf, r.receivedOn, r.referringOrganizationId, r.clinicalSummary],
        );
      }
      for (const a of s.authorizations) {
        await tx.query(
          "insert into refbiz.authorizations (account_id, authorization_id, subject_id, payer_display_name, service_code, status, units_approved, units_used, valid_from, valid_to, status_as_of) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [accountId, a.authorizationId, a.subjectId, a.payerDisplayName, a.serviceCode, a.status, a.unitsApproved, a.unitsUsed, a.validFrom, a.validTo, a.statusAsOf],
        );
      }
      for (const e of s.eligibility) {
        await tx.query("insert into refbiz.eligibility (account_id, subject_id, payer_display_name, coverage_status, verified_at, member_reference) values ($1, $2, $3, $4, $5, $6)", [
          accountId,
          e.subjectId,
          e.payerDisplayName,
          e.coverageStatus,
          e.verifiedAt,
          e.memberReference,
        ]);
      }
    });
    return { seeded: true };
  });

  app.post("/__admin/tls/hosts", async (req) => {
    const b = body(z.strictObject({ hostname: z.string().max(253), certPem: z.string().min(64).max(16_384), keyPem: z.string().min(64).max(16_384) }), req.body);
    try {
      deps.sni.register(b.hostname, b.certPem, b.keyPem);
    } catch {
      throw new ApiError(400, "TLS_MATERIAL_INVALID");
    }
    return { registered: b.hostname };
  });

  app.post("/__admin/endpoints", async () => deps.endpoints.open());
  app.get("/__admin/endpoints/:endpointId", async (req) => {
    const { endpointId } = body(z.object({ endpointId: Id }), req.params);
    const v = deps.endpoints.get(endpointId);
    if (!v) throw new ApiError(404, "NOT_FOUND");
    return v;
  });
  app.put("/__admin/endpoints/:endpointId/mode", async (req) => {
    const { endpointId } = body(z.object({ endpointId: Id }), req.params);
    const { mode } = body(z.strictObject({ mode: z.enum(["NORMAL", "REFUSE_CONNECTIONS", "STALL_HANDSHAKE"]) }), req.body);
    const v = await deps.endpoints.setMode(endpointId, mode);
    if (!v) throw new ApiError(404, "NOT_FOUND");
    return v;
  });
  app.delete("/__admin/endpoints/:endpointId", async (req) => {
    const { endpointId } = body(z.object({ endpointId: Id }), req.params);
    return { closed: await deps.endpoints.close(endpointId) };
  });

  app.post("/__admin/accounts/:accountId/faults", async (req) => {
    const accountId = P(req.params);
    await accountExists(store, accountId);
    const f = faults.arm(accountId, body(FaultInput, req.body));
    return { faultId: f.faultId };
  });
  app.get("/__admin/accounts/:accountId/faults", async (req) => ({ faults: faults.list(P(req.params)) }));
  app.delete("/__admin/accounts/:accountId/faults", async (req) => {
    faults.clear(P(req.params));
    return { cleared: true };
  });

  app.post("/__admin/accounts/:accountId/barriers", async (req) => {
    const accountId = P(req.params);
    await accountExists(store, accountId);
    const b = body(BarrierInput, req.body);
    const barrier = faults.addBarrier(accountId, b.operation, b.resourceId, b.parties, b.timeoutMs);
    return { barrierId: barrier.barrierId };
  });
  app.get("/__admin/accounts/:accountId/barriers", async (req) => ({
    barriers: faults.barriersOf(P(req.params)).map((b) => ({ barrierId: b.barrierId, operation: b.operation, resourceId: b.resourceId, parties: b.parties, arrived: b.arrived, released: b.released, timedOut: b.timedOut })),
  }));

  app.post("/__admin/accounts/:accountId/slots/:slotId/touch", async (req) => {
    const p = body(z.object({ accountId: Id, slotId: Id }), req.params);
    const rows = await store.query<{ version: number }>("update refbiz.slots set version = version + 1 where account_id = $1 and slot_id = $2 returning version", [p.accountId, p.slotId]);
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND");
    return { version: String(rows[0].version) };
  });

  app.get("/__admin/accounts/:accountId/effects", async (req) => {
    const accountId = P(req.params);
    const q = body(z.object({ resourceId: Id.optional() }).strict(), req.query);
    const rows = await store.query<{ seq: string; key_ref: string | null; operation: string; resource_type: string; resource_id: string; before_version: string | null; after_version: string; at: Date }>(
      "select * from refbiz.effects where account_id = $1 and ($2::text is null or resource_id = $2) order by seq",
      [accountId, q.resourceId ?? null],
    );
    return {
      effects: rows.map((r) => ({ seq: Number(r.seq), requestId: r.key_ref, operation: r.operation, resourceType: r.resource_type, resourceId: r.resource_id, beforeVersion: r.before_version, afterVersion: r.after_version, at: r.at.toISOString() })),
    };
  });

  app.get("/__admin/accounts/:accountId/requests", async (req) => ({ requests: faults.requestsOf(P(req.params)) }));

  app.get("/__admin/accounts/:accountId/change-requests/:requestId", async (req) => {
    const p = body(z.object({ accountId: Id, requestId: Id }), req.params);
    const rows = await store.query<Record<string, unknown>>(
      "select key_ref as request_id, operation, state, failure_code, resource_id, before_version, after_version, receipt_id, applied_at, completed_at, visible_at, not_after from refbiz.change_requests where account_id = $1 and key_ref = $2",
      [p.accountId, p.requestId],
    );
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND");
    return rows[0];
  });

  app.get("/__admin/accounts/:accountId/legacy-references/:externalRef", async (req) => {
    const p = body(z.object({ accountId: Id, externalRef: Id }), req.params);
    const rows = await store.query<Record<string, unknown>>(
      "select external_ref, state, dispatch_id is not null as reserved, not_after, reserved_at, posted_at, fenced_at from refbiz.legacy_references where account_id = $1 and external_ref = $2",
      [p.accountId, p.externalRef],
    );
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND");
    return rows[0];
  });

  app.delete("/__admin/accounts/:accountId", async (req) => {
    faults.forget(P(req.params));
    return { forgotten: true };
  });

  return app;
}
