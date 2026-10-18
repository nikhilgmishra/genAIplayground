/**
 * Case follow-up (spec sections 8, 9): status of the authorized subject's or
 * organization's own support request, and a short repeat-caller recap.
 *
 * - Restricted (privacy / safety) requests are invisible here (runtime RLS).
 * - Status comes from the internal record plus the linked workflow state; a created
 *   Case is never reported as resolved (ACT-04).
 * - The recap uses SupportMemory only as a POINTER (DATA-04: memory is not authority), only at
 *   A2+ for the same subject, and is suppressed by participant-change, recovery, fraud or safety
 *   risk flags. Before anything is spoken the referenced support request is re-read from the
 *   system of record: it must still exist in the caller's (runtime, non-restricted) view, still
 *   name the caller's own subject and still be OPEN (its authoritative CaseView status is neither
 *   COMPLETED nor CLOSED and its disposition is not RESOLVED). The spoken category is the
 *   record's, never the memory's. A stale memory entry is skipped (DP-03).
 */
import type { MemoryEntry } from "../../memory/ports.js";
import type { AuthContext, IssueCategory, SupportRequest } from "../../protocol/index.js";
import { IssueCategory as IssueCategorySchema, SupportReference } from "../../protocol/index.js";
import type { ToolDeps } from "../contract.js";
import { atLeast } from "../shared.js";
import type { PgSupportRequestService } from "../support/support-request-service.js";

export const CASE_STATUSES = ["RECEIVED", "IN_PROGRESS", "WAITING_FOR_YOU", "WAITING_FOR_OUR_TEAM", "COMPLETED", "CLOSED"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface CaseView {
  caseRef: string;
  category: IssueCategory;
  status: CaseStatus;
  nextStep: string | null;
  deadline: string | null;
}

export interface Recap {
  supportReference: string;
  issueCategory: IssueCategory;
  provenance: MemoryEntry["provenance"];
  /** The authoritative view the recap was checked against (status is open). */
  view: CaseView;
}

/** Statuses after which a request is no longer an open issue to recap. */
export const CLOSED_CASE_STATUSES: ReadonlySet<CaseStatus> = new Set(["COMPLETED", "CLOSED"]);

const WORKFLOW_STATUS: Record<string, CaseStatus> = {
  ACCEPTED: "RECEIVED",
  VALIDATING: "IN_PROGRESS",
  WAITING_FOR_SYSTEM: "IN_PROGRESS",
  WAITING_FOR_HUMAN: "WAITING_FOR_OUR_TEAM",
  WAITING_FOR_CALLER: "WAITING_FOR_YOU",
  READY_TO_COMMIT: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "WAITING_FOR_OUR_TEAM",
  CANCELLED: "CLOSED",
};

export class CaseService {
  constructor(
    private readonly deps: ToolDeps,
    private readonly support: PgSupportRequestService,
  ) {}

  /** Authoritative scope of a support reference (runtime view; restricted records resolve to null). */
  async scopeOf(tenantId: string, reference: string): Promise<{ sr: SupportRequest; organizationRef: string | null } | null> {
    if (!SupportReference.safeParse(reference).success) return null;
    const sr = await this.support.getByReference(tenantId, reference);
    if (!sr) return null;
    return { sr, organizationRef: await this.support.organizationOf(tenantId, sr.supportRequestId) };
  }

  async view(sr: SupportRequest): Promise<CaseView> {
    let status: CaseStatus = sr.disposition === "RESOLVED" ? "COMPLETED" : "RECEIVED";
    const { workflowIds } = await this.support.linkedRefs(sr.tenantId, sr.supportRequestId);
    const wfId = workflowIds[0];
    if (wfId) {
      const wf = await this.deps.workflows.get(sr.tenantId, wfId).catch(() => null);
      if (wf) status = WORKFLOW_STATUS[wf.state] ?? "IN_PROGRESS";
    } else if (sr.syncState === "SYNCED" && sr.salesforceCaseId) {
      status = "IN_PROGRESS";
    }
    return { caseRef: sr.referenceNumber, category: sr.issueCategory, status, nextStep: sr.nextStep, deadline: sr.deadline };
  }

  async forSubject(tenantId: string, subjectRef: string): Promise<CaseView[]> {
    const list = await this.support.listForScope(tenantId, { subjectRef }, 5);
    return Promise.all(list.map((sr) => this.view(sr)));
  }

  async forOrganization(tenantId: string, organizationRef: string): Promise<CaseView[]> {
    const list = await this.support.listForScope(tenantId, { organizationRef }, 5);
    return Promise.all(list.map((sr) => this.view(sr)));
  }

  /**
   * Repeat-caller recap: A2+ same subject, risk flags passed; the memory entry is only a pointer that is
   * reconciled with the system of record before it can be spoken (DATA-04, DP-03).
   */
  async recap(auth: AuthContext): Promise<Recap | null> {
    if (!auth.subjectId || !atLeast(auth.assurance, "A2")) return null;
    const entries = await this.deps.memory
      .recapFor({ tenantId: auth.tenantId, subjectId: auth.subjectId, assurance: auth.assurance, authorizedSubjectId: auth.subjectId, now: this.deps.clock.now(), riskFlags: [...auth.riskFlags] })
      .catch(() => [] as MemoryEntry[]);
    for (const e of entries) {
      if (e.kind !== "OPEN_ISSUE") continue;
      const ref = e.value.supportReference;
      const cat = typeof e.value.issueCategory === "string" ? IssueCategorySchema.safeParse(e.value.issueCategory.toLowerCase()) : null;
      if (typeof ref !== "string" || !SupportReference.safeParse(ref).success || !cat?.success) continue;
      // The authoritative record, in the caller's runtime view (restricted rows are invisible).
      const sr = await this.support.getByReference(auth.tenantId, ref).catch(() => null);
      if (!sr || sr.subjectRef !== auth.subjectId || sr.disposition === "RESOLVED") continue;
      const view = await this.view(sr).catch(() => null);
      if (!view || CLOSED_CASE_STATUSES.has(view.status)) continue;
      return { supportReference: sr.referenceNumber, issueCategory: sr.issueCategory, provenance: e.provenance, view };
    }
    return null;
  }
}
