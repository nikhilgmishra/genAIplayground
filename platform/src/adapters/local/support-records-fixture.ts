/**
 * LOCAL FIXTURE — Salesforce-like SupportRecordSystem over in-memory SYNTHETIC
 * records. NOT Salesforce and NOT sandbox evidence; rejected by the production
 * configuration guard (OPS-04). The live adapter is
 * live/salesforce-rest-support-records.ts (schema BLOCKED on PRQ-006).
 *
 * Models the Salesforce behaviour the platform depends on (spec section 8):
 *  - upsert by external id: repeated calls with the same external id update the
 *    same record and never create a duplicate (retry, redelivery and
 *    crash-after-write safe: ACT-02);
 *  - interaction and issue (Case) are SEPARATE objects; links form a
 *    many-to-many relation, so one call can address several Cases and a repeat
 *    call can refer to an existing Case;
 *  - restricted records (privacy / safety events) are kept apart from broadly
 *    visible Cases (visibility RESTRICTED);
 *  - Case status and ownership are managed by humans in Salesforce; an upsert
 *    from the platform never resets them, and a created Case is not a resolution
 *    (ACT-04);
 *  - faults: OUTAGE (Salesforce unavailable -> caller keeps an internal support
 *    reference, reconciled later), TIMEOUT_AFTER_COMMIT ("timeout after write":
 *    record exists, outcome UNKNOWN), PARTIAL_WRITE (Case written, interaction
 *    link not written), DUPLICATE_DELIVERY, QUOTA_EXHAUSTED, SLOW, STALE_READ.
 *
 * Record ids imitate the 15/18-character Salesforce id SHAPE with a SYN marker;
 * they are not real Salesforce ids.
 */
import { randomInt } from "node:crypto";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { iso, systemClock, type Clock } from "../../shared/clock.js";
import { ValidationError } from "../../shared/errors.js";
import type { AdapterHealth, CaseFields, SupportRecordSystem } from "../ports.js";
import { CaseFieldsSchema, InteractionExternalId, InteractionFieldsSchema, IssueExternalId, type InteractionFields } from "../support-records-schema.js";
import { READ_FAULTS, WRITE_FAULTS, noFaults, type ActiveFaults, type FaultInjector } from "./faults.js";
import { LOCAL_FIXTURE_LABEL } from "./synthetic-store.js";

export interface FixtureInteractionRecord extends InteractionFields {
  recordId: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
  writes: number;
}

export interface FixtureCaseRecord {
  caseId: string;
  externalId: string;
  fields: CaseFields;
  /** Managed in Salesforce by humans/automation; never set by an upsert. */
  status: string;
  visibility: "STANDARD" | "RESTRICTED";
  createdAt: string;
  updatedAt: string;
  writes: number;
}

export interface FixtureCaseLink {
  interactionExternalId: string;
  caseExternalId: string;
  createdAt: string;
}

export interface SupportRecordsFixtureOptions {
  faults?: FaultInjector;
  clock?: Clock;
  logger?: Logger;
}

export const SUPPORT_RECORDS_FIXTURE_OPERATIONS = {
  upsertInteraction: WRITE_FAULTS,
  upsertCase: WRITE_FAULTS,
  getCaseByExternalId: READ_FAULTS,
} as const;

/** Status a new fixture Case starts in (a LOCAL FIXTURE value; the tenant's picklist is UNKNOWN, PRQ-006). */
export const FIXTURE_NEW_CASE_STATUS = "NEW";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const syntheticRecordId = (prefix: string): string => {
  let s = `${prefix}SYN`;
  while (s.length < 18) s += ALNUM[randomInt(ALNUM.length)];
  return s;
};
const linkKey = (interactionExternalId: string, caseExternalId: string) => `${interactionExternalId}|${caseExternalId}`;

export class SupportRecordsFixture implements SupportRecordSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "salesforce";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly faults: FaultInjector;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly interactions = new Map<string, FixtureInteractionRecord>();
  private readonly cases = new Map<string, FixtureCaseRecord>();
  private readonly previousCases = new Map<string, FixtureCaseRecord>();
  private readonly links = new Map<string, FixtureCaseLink>();
  private deliveryCount = 0;

  constructor(opts: SupportRecordsFixtureOptions = {}) {
    this.faults = opts.faults ?? noFaults();
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "support_records_fixture" });
    this.faults.declare(this.integrationId, SUPPORT_RECORDS_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async upsertInteraction(
    externalId: string,
    fields: { callId: string; language: string; consentStatus: string; startedAt: string },
  ): Promise<{ recordId: string; created: boolean }> {
    if (!InteractionExternalId.safeParse(externalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    const parsed = InteractionFieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ValidationError("SUPPORT_INTERACTION_FIELDS_INVALID");
    const data = parsed.data;
    return this.write("upsertInteraction", () => {
      const now = iso(this.clock.now());
      const existing = this.interactions.get(externalId);
      if (existing) {
        this.interactions.set(externalId, { ...existing, ...data, updatedAt: now, writes: existing.writes + 1 });
        return { recordId: existing.recordId, created: false };
      }
      const recordId = syntheticRecordId("a00");
      this.interactions.set(externalId, { recordId, externalId, ...data, createdAt: now, updatedAt: now, writes: 1 });
      return { recordId, created: true };
    });
  }

  async upsertCase(externalId: string, interactionExternalId: string, fields: CaseFields): Promise<{ caseId: string; created: boolean }> {
    if (!IssueExternalId.safeParse(externalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    if (!InteractionExternalId.safeParse(interactionExternalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    const parsed = CaseFieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ValidationError("SUPPORT_CASE_FIELDS_INVALID");
    const data = parsed.data;
    return this.write("upsertCase", (f, duplicate) => {
      // Salesforce rejects a lookup to an external id that does not exist.
      if (!this.interactions.has(interactionExternalId)) throw new ValidationError("SUPPORT_INTERACTION_NOT_FOUND");
      const now = iso(this.clock.now());
      const existing = this.cases.get(externalId);
      let result: { caseId: string; created: boolean };
      if (existing) {
        this.previousCases.set(externalId, structuredClone(existing));
        this.cases.set(externalId, {
          ...existing,
          fields: structuredClone(data),
          visibility: existing.visibility === "RESTRICTED" || data.restricted ? "RESTRICTED" : "STANDARD",
          updatedAt: now,
          writes: existing.writes + 1,
        });
        result = { caseId: existing.caseId, created: false };
      } else {
        const caseId = syntheticRecordId("500");
        this.cases.set(externalId, {
          caseId,
          externalId,
          fields: structuredClone(data),
          status: FIXTURE_NEW_CASE_STATUS,
          visibility: data.restricted ? "RESTRICTED" : "STANDARD",
          createdAt: now,
          updatedAt: now,
          writes: 1,
        });
        result = { caseId, created: true };
      }
      if (f.has("PARTIAL_WRITE") && !duplicate) throw f.partialWriteError(); // Case written; link not written
      const key = linkKey(interactionExternalId, externalId);
      if (!this.links.has(key)) this.links.set(key, { interactionExternalId, caseExternalId: externalId, createdAt: now });
      return result;
    });
  }

  async getCaseByExternalId(externalId: string): Promise<{ caseId: string; status: string; ownerQueue: string } | null> {
    if (!IssueExternalId.safeParse(externalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    const f = this.faults.begin(this.integrationId, "getCaseByExternalId");
    await f.beforeSend();
    const c = f.has("STALE_READ") ? (this.previousCases.get(externalId) ?? this.cases.get(externalId)) : this.cases.get(externalId);
    return c ? { caseId: c.caseId, status: c.status, ownerQueue: c.fields.ownerQueue } : null;
  }

  // ---------------- LOCAL FIXTURE test helpers ----------------

  /** Copies of every stored record, for assertions. */
  records(): { interactions: FixtureInteractionRecord[]; cases: FixtureCaseRecord[]; links: FixtureCaseLink[] } {
    return {
      interactions: [...this.interactions.values()].map((r) => structuredClone(r)),
      cases: [...this.cases.values()].map((r) => structuredClone(r)),
      links: [...this.links.values()].map((r) => ({ ...r })),
    };
  }

  casesForInteraction(interactionExternalId: string): string[] {
    return [...this.links.values()].filter((l) => l.interactionExternalId === interactionExternalId).map((l) => l.caseExternalId).sort();
  }

  interactionsForCase(caseExternalId: string): string[] {
    return [...this.links.values()].filter((l) => l.caseExternalId === caseExternalId).map((l) => l.interactionExternalId).sort();
  }

  /** Simulates human / Salesforce automation working the Case. */
  setCaseStatus(externalId: string, status: string): void {
    const c = this.cases.get(externalId);
    if (!c) throw new ValidationError("SUPPORT_CASE_NOT_FOUND");
    this.previousCases.set(externalId, structuredClone(c));
    this.cases.set(externalId, { ...c, status, updatedAt: iso(this.clock.now()) });
  }

  /** Write requests received, including DUPLICATE_DELIVERY copies. */
  get deliveries(): number {
    return this.deliveryCount;
  }

  apiCallCount(operation: keyof typeof SUPPORT_RECORDS_FIXTURE_OPERATIONS): number {
    return this.faults.callCount(this.integrationId, operation);
  }

  // ---------------- internals ----------------

  private async write<R>(operation: "upsertInteraction" | "upsertCase", apply: (f: ActiveFaults, duplicate: boolean) => R): Promise<R> {
    const f = this.faults.begin(this.integrationId, operation);
    await f.beforeSend();
    const copies = f.has("DUPLICATE_DELIVERY") ? 2 : 1;
    let first: R | undefined;
    for (let delivery = 1; delivery <= copies; delivery++) {
      this.deliveryCount += 1;
      const r = apply(f, delivery > 1);
      if (delivery === 1) first = r;
    }
    f.afterCommit();
    this.logger.debug("fixture.support_records.upsert", { operation });
    return first as R;
  }
}
