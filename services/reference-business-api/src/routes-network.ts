/**
 * Provider network (onboarding, credentialing documents, remittance) and referral / authorization / eligibility
 * status systems of record (WP-23; canonical provider and referral contracts).
 *
 * Every answer is the authoritative system's statement with its as-of time: an onboarding stage, a document
 * status, a remittance the payer side scheduled or sent, a referral's status, a payer-reported authorization or
 * eligibility response. Nothing here authorizes a payout, decides coverage or states clinical suitability
 * (FO-06-76); program membership is not part of this API at all (FO-01-30, FO-06-73).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "./errors.js";
import type { ApiDeps } from "./http.js";
import { get, Id, parse } from "./http.js";
import { authorization, eligibility, onboarding, onboardingDocument, referral, remittance } from "./representation.js";

const Periods = z.object({ periods: z.coerce.number().int().min(1).max(24).default(6) }).strict();

export function networkRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store } = deps;

  get(app, deps, "/api/v1/providers/:providerId/onboarding", "provider.onboarding.get", "provider:read", async (ctx, req) => {
    const { providerId } = parse(z.object({ providerId: Id }), req.params);
    const r = (await store.query<Parameters<typeof onboarding>[0]>("select * from refbiz.onboarding where account_id = $1 and provider_id = $2", [ctx.account.account_id, providerId]))[0];
    if (!r) throw notFound();
    return onboarding(r);
  });

  get(app, deps, "/api/v1/providers/:providerId/onboarding/documents", "provider.documents.list", "provider:read", async (ctx, req) => {
    const { providerId } = parse(z.object({ providerId: Id }), req.params);
    const acct = ctx.account.account_id;
    if ((await store.query("select 1 from refbiz.onboarding where account_id = $1 and provider_id = $2", [acct, providerId])).length === 0) throw notFound();
    const rows = await store.query<Parameters<typeof onboardingDocument>[0]>("select * from refbiz.onboarding_documents where account_id = $1 and provider_id = $2 order by document_type", [acct, providerId]);
    return { items: rows.map(onboardingDocument), nextCursor: null };
  });

  // The most recent `periods` remittances of a practice (no dates in the URL: they would read as personal data).
  get(app, deps, "/api/v1/practices/:practiceId/remittances", "provider.remittances.list", "provider:read", async (ctx, req) => {
    const { practiceId } = parse(z.object({ practiceId: Id }), req.params);
    const q = parse(Periods, req.query);
    const rows = await store.query<Parameters<typeof remittance>[0]>(
      "select * from refbiz.remittances where account_id = $1 and practice_id = $2 order by period_end desc, remittance_id limit $3",
      [ctx.account.account_id, practiceId, q.periods],
    );
    return { items: rows.map(remittance), nextCursor: null };
  });

  get(app, deps, "/api/v1/subjects/:subjectId/referrals", "referrals.list", "referrals:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const rows = await store.query<Parameters<typeof referral>[0]>("select * from refbiz.referrals where account_id = $1 and subject_id = $2 order by received_on desc, referral_id limit 100", [ctx.account.account_id, subjectId]);
    return { items: rows.map(referral), nextCursor: null };
  });

  get(app, deps, "/api/v1/referrals/:referralId", "referrals.get", "referrals:read", async (ctx, req) => {
    const { referralId } = parse(z.object({ referralId: Id }), req.params);
    const r = (await store.query<Parameters<typeof referral>[0]>("select * from refbiz.referrals where account_id = $1 and referral_id = $2", [ctx.account.account_id, referralId]))[0];
    if (!r) throw notFound();
    return referral(r);
  });

  get(app, deps, "/api/v1/subjects/:subjectId/authorizations", "authorizations.list", "referrals:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const rows = await store.query<Parameters<typeof authorization>[0]>(
      "select * from refbiz.authorizations where account_id = $1 and subject_id = $2 order by status_as_of desc, authorization_id limit 100",
      [ctx.account.account_id, subjectId],
    );
    return { items: rows.map(authorization), nextCursor: null };
  });

  get(app, deps, "/api/v1/subjects/:subjectId/eligibility", "eligibility.get", "referrals:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const r = (await store.query<Parameters<typeof eligibility>[0]>("select * from refbiz.eligibility where account_id = $1 and subject_id = $2", [ctx.account.account_id, subjectId]))[0];
    if (!r) throw notFound();
    return eligibility(r);
  });
}
