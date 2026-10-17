import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { conflicts, findConflicts, resolveConflicts, windowsOverlap } from "./conflicts.js";
import type { ConflictCandidate } from "./conflicts.js";
import { EMBEDDING_DIMENSIONS, LocalHashingEmbedder, cosineSimilarity, hashingEmbedding, stem, tokenize } from "./embedding.js";

const c = (over: Partial<ConflictCandidate>): ConflictCandidate => ({
  sourceId: "a",
  version: 1,
  sourceSystem: "salesforce_knowledge",
  audiences: ["public"],
  permittedIntents: ["late_fee_question"],
  language: "en",
  jurisdiction: "US",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  contentDigest: "1".repeat(64),
  ...over,
});

describe("conflict detection", () => {
  it("[SPEC-9.conflict] same intent+audience+language+jurisdiction, overlapping windows and different content conflict", () => {
    expect(conflicts(c({}), c({ sourceId: "b", contentDigest: "2".repeat(64) }))).toBe(true);
    expect(conflicts(c({}), c({ sourceId: "b" }))).toBe(false); // identical content
    expect(conflicts(c({}), c({ sourceId: "a", version: 2, contentDigest: "2".repeat(64) }))).toBe(false); // same source = supersession
    expect(conflicts(c({}), c({ sourceId: "b", contentDigest: "2".repeat(64), language: "es" }))).toBe(false);
    expect(conflicts(c({}), c({ sourceId: "b", contentDigest: "2".repeat(64), jurisdiction: "CA" }))).toBe(false);
    expect(conflicts(c({}), c({ sourceId: "b", contentDigest: "2".repeat(64), audiences: ["provider"] }))).toBe(false);
    expect(conflicts(c({}), c({ sourceId: "b", contentDigest: "2".repeat(64), permittedIntents: ["other_intent"] }))).toBe(false);
    expect(conflicts(c({ expiresAt: "2026-02-01T00:00:00.000Z" }), c({ sourceId: "b", contentDigest: "2".repeat(64), effectiveFrom: "2026-02-01T00:00:00.000Z" }))).toBe(false);
  });

  it("[SPEC-9.conflict] property: window overlap is symmetric", () => {
    const iso = fc.integer({ min: 0, max: 1000 }).map((d) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString());
    fc.assert(
      fc.property(iso, iso, fc.option(iso), fc.option(iso), (af, bf, at, bt) => {
        const a = { effectiveFrom: af, expiresAt: at };
        const b = { effectiveFrom: bf, expiresAt: bt };
        expect(windowsOverlap(a, b)).toBe(windowsOverlap(b, a));
      }),
      { numRuns: 300, seed: 11 },
    );
  });

  it("[SPEC-9.conflict] precedence decides only across different source systems and only when approved", () => {
    const sf = c({ sourceId: "kb" });
    const rb = c({ sourceId: "rb", sourceSystem: "approved_runbook", contentDigest: "2".repeat(64) });
    const sf2 = c({ sourceId: "kb2", contentDigest: "3".repeat(64) });
    const pairs = findConflicts([sf, rb, sf2], []);
    expect(pairs).toHaveLength(3);
    const approved = resolveConflicts(pairs, { order: ["approved_runbook", "salesforce_knowledge"], approvalRef: "apr_testOnlyPrecedence1" });
    expect([...approved.held.entries()].sort()).toEqual([
      ["kb2@v1", "KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW"],
      ["kb@v1", "KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW"],
    ]);
    expect(approved.held.has("rb@v1")).toBe(false);
    const unapproved = resolveConflicts(pairs, { order: ["approved_runbook", "salesforce_knowledge"], approvalRef: null });
    expect(unapproved.held.size).toBe(3);
    expect(resolveConflicts(pairs, null).held.size).toBe(3);
  });
});

describe("LocalHashingEmbedder (LOCAL FIXTURE)", () => {
  it("[OPS-06] embeddings are deterministic, normalized and pinned by model id", async () => {
    const e = new LocalHashingEmbedder();
    expect(e.kind).toBe("local_fixture");
    const a = await e.embed("Reschedule an appointment in the portal");
    const b = await e.embed("Reschedule an appointment in the portal");
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.abs(Math.sqrt(a.reduce((s, x) => s + x * x, 0)) - 1)).toBeLessThan(1e-3);
    expect(cosineSimilarity(a, hashingEmbedding("rescheduling appointments"))).toBeGreaterThan(cosineSimilarity(a, hashingEmbedding("billing statement charges")));
    expect(hashingEmbedding("")).toEqual(new Array(EMBEDDING_DIMENSIONS).fill(0));
  });

  it("[SPEC-9.retrieval] tokenizer drops stop words and folds accents and simple suffixes", () => {
    expect(tokenize("The Appointments are RESCHEDULED")).toEqual(["appoint", "reschedul"]);
    expect(tokenize("verificación")).toEqual(["verificacion"]);
    expect(stem("policies")).toBe("policy");
  });
});
