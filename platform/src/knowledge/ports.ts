import type { Assurance, Role } from "../protocol/index.js";

/** Approved knowledge item metadata (spec section 9). */
export interface KnowledgeItemInput {
  sourceId: string;
  sourceSystem: "salesforce_knowledge" | "approved_runbook";
  version: number;
  title: string;
  body: string;
  owner: string;
  audiences: (Role | "public")[];
  permittedIntents: string[];
  jurisdiction: string;
  language: string;
  effectiveFrom: string;
  expiresAt: string | null;
  sensitivity: "PUBLIC" | "INTERNAL";
  approval: { status: "APPROVED" | "PENDING" | "REJECTED"; approvedBy: string | null; approvedAt: string | null };
}

export interface IngestReport {
  accepted: string[];
  quarantined: { sourceId: string; reasonCodes: string[] }[];
  conflicts: { sourceIds: string[]; reasonCode: string }[];
  snapshotVersion: string;
  snapshotDigest: string;
}

export interface KnowledgeHit {
  citationId: string;
  sourceId: string;
  version: number;
  title: string;
  /** Sanitized excerpt from an approved article; used only for grounded low-risk paraphrase. */
  excerpt: string;
  score: number;
}

export interface KnowledgeService {
  ingest(tenantId: string, items: KnowledgeItemInput[]): Promise<IngestReport>;
  /** Filters by authorization/policy BEFORE ranking and again before return. */
  search(input: {
    tenantId: string;
    query: string;
    /** Server-established selected role, or "public" for unverified/public callers. */
    audience: Role | "public";
    intent: string;
    language: string;
    jurisdiction: string;
    now: Date;
    limit: number;
    /**
     * Optional server-established assurance tier (added by the knowledge module,
     * backward compatible). A0 forces the public corpus (PUBLIC sensitivity and
     * "public" audience) regardless of the claimed audience. Callers should pass it.
     */
    assurance?: Assurance;
  }): Promise<KnowledgeHit[]>;
  snapshot(tenantId: string): Promise<{ version: string; digest: string }>;
}
