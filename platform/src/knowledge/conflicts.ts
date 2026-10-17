/**
 * Conflict detection and approved source precedence (spec section 9: "Use
 * approved source precedence; conflicting or expired instructions require
 * human review").
 *
 * Two items from DIFFERENT sources conflict when they share at least one
 * permitted intent and one audience, have the same language and jurisdiction,
 * overlapping effective windows, and different content digests. (A newer
 * version of the SAME source supersedes; it is not a conflict.)
 *
 * Resolution:
 *  - with an APPROVED precedence order and different source systems, the
 *    higher-precedence item stays servable and the lower one is held for review;
 *  - otherwise (no approved precedence, or the same source system) BOTH are
 *    held for human review.
 * Every conflict is reported. Holds are released only by a human reviewer.
 */
export type SourceSystem = "salesforce_knowledge" | "approved_runbook";

export interface SourcePrecedence {
  /** Highest precedence first. */
  order: SourceSystem[];
  /** Approval reference for the precedence rule; null = not approved = not applied. */
  approvalRef: string | null;
}

export interface ConflictCandidate {
  sourceId: string;
  version: number;
  sourceSystem: SourceSystem;
  audiences: readonly string[];
  permittedIntents: readonly string[];
  language: string;
  jurisdiction: string;
  effectiveFrom: string;
  expiresAt: string | null;
  contentDigest: string;
}

export interface ConflictPair {
  a: ConflictCandidate;
  b: ConflictCandidate;
}

export const keyOf = (c: Pick<ConflictCandidate, "sourceId" | "version">): string => `${c.sourceId}@v${c.version}`;

const intersects = (x: readonly string[], y: readonly string[]): boolean => x.some((v) => y.includes(v));

export function windowsOverlap(a: Pick<ConflictCandidate, "effectiveFrom" | "expiresAt">, b: Pick<ConflictCandidate, "effectiveFrom" | "expiresAt">): boolean {
  const aFrom = Date.parse(a.effectiveFrom);
  const bFrom = Date.parse(b.effectiveFrom);
  const aTo = a.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.expiresAt);
  const bTo = b.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.expiresAt);
  return aFrom < bTo && bFrom < aTo;
}

export function conflicts(a: ConflictCandidate, b: ConflictCandidate): boolean {
  return (
    a.sourceId !== b.sourceId &&
    a.language === b.language &&
    a.jurisdiction === b.jurisdiction &&
    intersects(a.permittedIntents, b.permittedIntents) &&
    intersects(a.audiences, b.audiences) &&
    windowsOverlap(a, b) &&
    a.contentDigest !== b.contentDigest
  );
}

/** All conflicting pairs among new candidates and between candidates and existing items. */
export function findConflicts(candidates: readonly ConflictCandidate[], existing: readonly ConflictCandidate[]): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (!a) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (b && conflicts(a, b)) pairs.push({ a, b });
    }
    for (const e of existing) if (conflicts(a, e)) pairs.push({ a, b: e });
  }
  return pairs;
}

export interface ConflictResolution {
  /** key -> review reason code */
  held: Map<string, string>;
  reported: { sourceIds: string[]; reasonCode: string }[];
}

export function precedenceApproved(p: SourcePrecedence | null | undefined): p is SourcePrecedence {
  return !!p && p.approvalRef !== null && p.order.length > 0;
}

export function resolveConflicts(pairs: readonly ConflictPair[], precedence: SourcePrecedence | null | undefined): ConflictResolution {
  const held = new Map<string, string>();
  const reported: ConflictResolution["reported"] = [];
  const approved = precedenceApproved(precedence);
  for (const { a, b } of pairs) {
    const sourceIds = [a.sourceId, b.sourceId].sort();
    const ra = approved ? precedence.order.indexOf(a.sourceSystem) : -1;
    const rb = approved ? precedence.order.indexOf(b.sourceSystem) : -1;
    if (approved && a.sourceSystem !== b.sourceSystem && ra >= 0 && rb >= 0) {
      const loser = ra < rb ? b : a;
      if (!held.has(keyOf(loser))) held.set(keyOf(loser), "KNOWLEDGE_CONFLICT_LOWER_PRECEDENCE");
      reported.push({ sourceIds, reasonCode: "KNOWLEDGE_CONFLICT_RESOLVED_BY_PRECEDENCE" });
    } else {
      held.set(keyOf(a), "KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW");
      held.set(keyOf(b), "KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW");
      reported.push({ sourceIds, reasonCode: "KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW" });
    }
  }
  return { held, reported };
}
