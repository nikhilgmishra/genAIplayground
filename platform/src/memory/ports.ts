/**
 * Limited support memory (spec section 9). Each field carries provenance and
 * expiry. Memory never grants authorization or becomes a medical fact (DATA-04);
 * recaps are disclosed only after authentication of the same subject.
 */
export type MemoryProvenance = "VERIFIED" | "CALLER_REPORTED" | "MACHINE_INFERRED";

export interface MemoryEntry {
  memoryId: string;
  tenantId: string;
  subjectId: string;
  kind: "PREFERENCE" | "OPEN_ISSUE" | "COMPLETED_ACTION" | "PROMISE" | "DEADLINE" | "REVIEWED_SUMMARY";
  /** Structured, template-renderable value; no free-text clinical content. */
  value: Record<string, string | number | boolean | null>;
  provenance: MemoryProvenance;
  sourceRef: string;
  createdAt: string;
  expiresAt: string;
}

export interface SupportMemory {
  record(entry: Omit<MemoryEntry, "memoryId" | "createdAt">): Promise<MemoryEntry>;
  /** Requires an A2+ context for the same subject; returns only unexpired entries. */
  recapFor(input: { tenantId: string; subjectId: string; assurance: string; authorizedSubjectId: string | null; now: Date }): Promise<MemoryEntry[]>;
  expire(now: Date): Promise<number>;
}
