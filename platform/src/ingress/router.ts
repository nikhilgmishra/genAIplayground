/**
 * Authenticated event ingress router (follow-on FO-07-16, FO-07-17, FO-15-50, FO-06-98; DATA-01, ACT-02).
 *
 * One entry point for every pushed event source. For a request it:
 *   1. resolves the source profile (unknown source: 404, nothing read);
 *   2. bounds the body (413 above the profile's maxBodyBytes);
 *   3. authenticates with the source's documented mechanism BEFORE anything is persisted (401 on a
 *      failure, 503 when credentials cannot be resolved; neither stores the body);
 *   4. for reconcile-by-lookup sources, replaces the delivered body with the authoritative record from a
 *      trusted server-side lookup (the delivered body is never trusted);
 *   5. classifies the payload against the source's explicit contracts (unknown type, field or schema:
 *      QUARANTINED, still stored encrypted and alarmed);
 *   6. persists the encrypted inbox record (with its audit event) and only then answers 2xx; a persist
 *      failure answers 503 so the sender redelivers (acknowledged events are never lost). An authentic
 *      byte-identical redelivery (a vendor retry after a lost acknowledgement, or a captured request
 *      replayed) is answered 200 "duplicate" and recorded, never applied twice; a token reused over other
 *      bytes is refused 401 INGRESS_REPLAYED by the inbox's durable replay cache.
 * Responses carry an inbox id and a decision code, never payload content; logs carry source ids (field
 * `integration`), inbox ids, digests, decisions (`outcome`) and reason codes, never a header value, a signature
 * or a secret.
 */
import type { Clock } from "../shared/clock.js";
import { PlatformError } from "../shared/errors.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { classify } from "./contracts.js";
import type { InboundContractRegistry } from "./contracts.js";
import type { PgInbox } from "./inbox.js";
import { InboxReplayRefusedError, authLabel, sha256HexOf } from "./inbox.js";
import { authMechanismOf } from "./profile.js";
import type { SourceProfileRegistry } from "./profile.js";
import type { InboundRequest, InboundVerifier } from "./verifiers.js";

/** Trusted server-side lookup of the authoritative record for a reconcile-by-lookup source. */
export interface ReconcileLookup {
  /** Returns the authoritative record bytes for the delivered event, or null when the source has no such record. */
  fetch(sourceId: string, deliveredEventId: string): Promise<Buffer | null>;
}

export interface IngressRouterDeps {
  profiles: SourceProfileRegistry;
  contracts: InboundContractRegistry;
  verifier: InboundVerifier;
  inbox: PgInbox;
  clock: Clock;
  /** Lookups by source id for reconcile_by_lookup sources. */
  lookups?: Readonly<Record<string, ReconcileLookup>>;
  logger?: Logger;
  metrics?: Metrics;
}

export type IngressDecision = "accepted" | "duplicate" | "quarantined";

export interface IngressResponse {
  status: 200 | 202 | 400 | 401 | 404 | 413 | 503;
  body: { accepted: true; decision: IngressDecision; inboxId: string } | { error: { reasonCode: string } };
}

const err = (status: IngressResponse["status"], reasonCode: string): IngressResponse => ({ status, body: { error: { reasonCode } } });

export class IngressRouter {
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(private readonly deps: IngressRouterDeps) {
    this.logger = (deps.logger ?? silentLogger).child({ component: "ingress_router" });
    this.metrics = deps.metrics ?? noopMetrics;
  }

  /** Largest body any configured source accepts (the HTTP layer's hard body limit). */
  get maxBodyBytes(): number {
    return Math.max(256, ...this.deps.profiles.all().map((p) => p.maxBodyBytes));
  }

  async handle(req: InboundRequest): Promise<IngressResponse> {
    const profile = this.deps.profiles.get(req.sourceId);
    if (!profile || profile.verifier.kind === "stream_iam") {
      this.count("source_unknown", "none");
      return err(404, "INGRESS_SOURCE_UNKNOWN");
    }
    const auth = authLabel(authMechanismOf(profile.verifier));
    if (req.rawBody.length > profile.maxBodyBytes) {
      this.count("size_rejected", auth);
      return err(413, "INGRESS_PAYLOAD_TOO_LARGE");
    }
    const verified = await this.deps.verifier.verify(req, profile);
    if (!verified.ok) {
      this.count("auth_rejected", auth);
      this.logger.warn("ingress.auth_rejected", { integration: profile.sourceId, reasonCode: verified.reasonCode });
      return verified.reasonCode === "INGRESS_CREDENTIALS_UNAVAILABLE" ? err(503, verified.reasonCode) : err(401, verified.reasonCode);
    }
    let body = req.rawBody;
    let classification = classify(body, profile, this.deps.contracts);
    if (profile.verifier.kind === "reconcile_by_lookup") {
      const lookup = this.deps.lookups?.[profile.sourceId];
      if (!lookup) return err(503, "INGRESS_LOOKUP_NOT_CONFIGURED");
      if (classification.eventId.startsWith("digest:")) return err(400, "INGRESS_EVENT_ID_MISSING");
      let authoritative: Buffer | null;
      try {
        authoritative = await lookup.fetch(profile.sourceId, classification.eventId);
      } catch {
        return err(503, "INGRESS_LOOKUP_UNAVAILABLE");
      }
      if (!authoritative) {
        this.count("auth_rejected", auth);
        return err(401, "INGRESS_LOOKUP_NOT_FOUND");
      }
      body = authoritative;
      const reclassified = classify(body, profile, this.deps.contracts);
      // The authoritative record must describe the same event the sender announced.
      if (reclassified.eventId !== classification.eventId) {
        this.count("auth_rejected", auth);
        this.logger.warn("ingress.auth_rejected", { integration: profile.sourceId, reasonCode: "INGRESS_LOOKUP_EVENT_MISMATCH" });
        return err(401, "INGRESS_LOOKUP_EVENT_MISMATCH");
      }
      classification = reclassified;
    }
    try {
      const r = await this.deps.inbox.accept({ profile, classification, rawBody: body, auth: { mechanism: verified.mechanism, credentialVersion: verified.credentialVersion }, replay: verified.replay });
      const decision: IngressDecision = r.duplicate ? "duplicate" : r.status === "QUARANTINED" ? "quarantined" : "accepted";
      // Field keys follow the content-free logger's allowlist (observability/logger.ts): the source id under
      // `integration`, the decision under `outcome`. The verifying credential version is recorded on the inbox row
      // and in the audit event (FO-07-19), not here: version ids are not a loggable shape.
      this.logger.info("ingress.persisted", { integration: profile.sourceId, inboxId: r.inboxId, outcome: decision, payloadDigest: sha256HexOf(body) });
      return { status: 200, body: { accepted: true, decision, inboxId: r.inboxId } };
    } catch (e) {
      if (e instanceof InboxReplayRefusedError) {
        this.count("auth_rejected", auth);
        this.logger.warn("ingress.auth_rejected", { integration: profile.sourceId, reasonCode: e.reasonCode });
        return err(401, e.reasonCode);
      }
      this.count("persist_failed", auth);
      const code = e instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.reasonCode) ? e.reasonCode : "INBOX_PERSIST_FAILED";
      this.logger.error("ingress.persist_failed", { integration: profile.sourceId, reasonCode: code });
      return err(503, code);
    }
  }

  private count(result: string, auth: string): void {
    try {
      this.metrics.increment("vsp_inbox_events_total", { result, auth });
    } catch {
      // metrics never change the decision
    }
  }
}
