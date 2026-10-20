/**
 * Decision-gated technologies (WP-06; FO-03-25, FO-08-17, FO-08-35, FO-23-08): nothing in the repository
 * uses EventBridge fan-out, graph retrieval, a similarity-keyed cache or the Personal Agent Protocol, and the
 * checker fails a fixture tree that adds any of them through a manifest, the lockfile, an import, a module
 * kind or a cache declaration without an Accepted ADR (and the evidence the gate names). The same gates
 * are enforced on imports by dependency-cruiser (depcruise.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { checkDecisionGates, type GateFinding } from "./decision-gates.js";
import { REPO, readRepoFile, sourceDirectories, type RegisterDoc } from "./support.js";

const doc = YAML.parse(readRepoFile(REPO, "platform/architecture/modules.yaml")) as RegisterDoc;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fixture repository: the given files plus a copy of the register (optionally edited). */
function fixture(files: Record<string, string>, edit: (d: RegisterDoc) => void = () => undefined): { root: string; reg: RegisterDoc } {
  const root = mkdtempSync(join(tmpdir(), "vsp-gates-"));
  roots.push(root);
  const reg = structuredClone(doc);
  edit(reg);
  for (const [rel, text] of Object.entries({ "package.json": JSON.stringify({ name: "fixture", private: true }), ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, reg };
}

const summary = (fs: GateFinding[]) => fs.map((f) => `${f.gate}:${f.source}`).sort();
const gate = (reg: RegisterDoc, id: string) => reg.decisionGates.find((g) => g.id === id)!;
const ACCEPTED = "# ADR-0099 Fan-out\n\n| Field | Value |\n|---|---|\n| Status | **Accepted** |\n";
const PROPOSED = "# ADR-0099 Fan-out\n\nStatus: **PROPOSED**\n";

describe("decision-gated technologies [FO-03-25][FO-08-17][FO-08-35][FO-23-08]", () => {
  it("[FO-03-25][FO-08-17][FO-08-35][FO-23-08] the repository uses no gated technology and no gate has a decision yet", () => {
    const dirs = [...doc.roots.flatMap((r) => (r.includes("*") ? sourceDirectories(REPO, [r]) : [r])), "platform/test", "scripts"];
    expect(checkDecisionGates(REPO, doc, dirs)).toEqual([]);
    expect(doc.decisionGates.map((g) => [g.requirementId, g.decision])).toEqual([
      ["FO-03-25", null],
      ["FO-08-17", null],
      ["FO-08-35", null],
      ["FO-23-08", null],
    ]);
  });

  it("[FO-03-25] adversarial: EventBridge in a manifest, the lockfile or an import fails without an Accepted ADR", () => {
    const { root, reg } = fixture({
      "media/package.json": JSON.stringify({ name: "m", dependencies: { "@aws-sdk/client-eventbridge": "3.1.0" } }),
      "pnpm-lock.yaml": "packages:\n\n  '@aws-sdk/client-eventbridge@3.1.0':\n    resolution: {}\n",
      "platform/src/outbox/fanout.ts": 'import { EventBridgeClient } from "@aws-sdk/client-eventbridge";\nexport const c = EventBridgeClient;\n',
    });
    expect(summary(checkDecisionGates(root, reg, ["platform/src"]))).toEqual(["eventbridge-fanout:import", "eventbridge-fanout:lockfile", "eventbridge-fanout:manifest"]);
  });

  it("[FO-03-25] a proposed ADR does not qualify; an Accepted ADR under docs/adr/ does", () => {
    const files = { "platform/src/outbox/fanout.ts": 'import { EventBridgeClient } from "@aws-sdk/client-eventbridge";\nexport const c = EventBridgeClient;\n' };
    const proposed = fixture({ ...files, "docs/adr/ADR-0099-fanout.md": PROPOSED }, (r) => (gate(r, "eventbridge-fanout").decision = { adr: "docs/adr/ADR-0099-fanout.md" }));
    expect(summary(checkDecisionGates(proposed.root, proposed.reg, ["platform/src"]))).toEqual(["eventbridge-fanout:decision", "eventbridge-fanout:import"]);
    const inProposedDir = fixture({ ...files, "docs/adr/proposed/WP-99-fanout.md": ACCEPTED }, (r) => (gate(r, "eventbridge-fanout").decision = { adr: "docs/adr/proposed/WP-99-fanout.md" }));
    expect(summary(checkDecisionGates(inProposedDir.root, inProposedDir.reg, ["platform/src"]))).toEqual(["eventbridge-fanout:decision", "eventbridge-fanout:import"]);
    const accepted = fixture({ ...files, "docs/adr/ADR-0099-fanout.md": ACCEPTED }, (r) => (gate(r, "eventbridge-fanout").decision = { adr: "docs/adr/ADR-0099-fanout.md" }));
    expect(checkDecisionGates(accepted.root, accepted.reg, ["platform/src"])).toEqual([]);
  });

  it("[FO-08-17] adversarial: a graph retriever module or graph driver needs an Accepted ADR and a retrieval evaluation report showing gains", () => {
    const files = { "platform/src/grounding/graph.ts": 'import neo4j from "neo4j-driver";\nexport const d = neo4j;\n', "docs/adr/ADR-0099-graph.md": ACCEPTED };
    const addModule = (r: RegisterDoc) => r.modules.push({ id: "graph-retriever", path: "platform/src/grounding/graph", kind: "graph-retriever", status: "planned", owner: "WP-20", allow: [] } as never);
    const none = fixture(files, addModule);
    expect(summary(checkDecisionGates(none.root, none.reg, ["platform/src"]))).toEqual(["graph-retrieval:import", "graph-retrieval:module"]);
    const noReport = fixture(files, (r) => {
      addModule(r);
      gate(r, "graph-retrieval").decision = { adr: "docs/adr/ADR-0099-graph.md" };
    });
    const f = checkDecisionGates(noReport.root, noReport.reg, ["platform/src"]);
    expect(summary(f)).toEqual(["graph-retrieval:decision", "graph-retrieval:import", "graph-retrieval:module"]);
    expect(f.find((x) => x.source === "decision")?.detail).toMatch(/evaluation report under evidence\/evaluation\/retrieval\//);
    const withReport = fixture({ ...files, "evidence/evaluation/retrieval/graph-vs-hybrid.json": "{}" }, (r) => {
      addModule(r);
      gate(r, "graph-retrieval").decision = { adr: "docs/adr/ADR-0099-graph.md", evaluationReport: "evidence/evaluation/retrieval/graph-vs-hybrid.json" };
    });
    expect(checkDecisionGates(withReport.root, withReport.reg, ["platform/src"])).toEqual([]);
  });

  it("[FO-08-35] adversarial: a similarity-keyed cache needs an Accepted ADR, the FO-07-42 key and a re-check-on-return test tagged [FO-08-35]", () => {
    const files = { "platform/src/knowledge/semantic-cache.ts": 'import { SemanticCache } from "@upstash/semantic-cache";\nexport const s = SemanticCache;\n', "docs/adr/ADR-0099-cache.md": ACCEPTED };
    const addCache = (r: RegisterDoc, extra: object = {}) => r.caches.push({ file: "platform/src/knowledge/semantic-cache.ts", cacheKind: "semantic", key: "query embedding", ...extra });
    const none = fixture(files, (r) => addCache(r));
    expect(summary(checkDecisionGates(none.root, none.reg, ["platform/src"]))).toEqual(["semantic-cache:cache", "semantic-cache:import"]);
    const noKey = fixture(files, (r) => {
      addCache(r);
      gate(r, "semantic-cache").decision = { adr: "docs/adr/ADR-0099-cache.md" };
    });
    expect(checkDecisionGates(noKey.root, noKey.reg, ["platform/src"]).find((x) => x.source === "decision")?.detail).toMatch(/keyRequirement FO-07-42, disclosureRecheck: true and a recheckTest tagged \[FO-08-35\]/);
    const untested = fixture(files, (r) => {
      addCache(r, { keyRequirement: "FO-07-42", disclosureRecheck: true, recheckTest: "platform/src/knowledge/semantic-cache.test.ts" });
      gate(r, "semantic-cache").decision = { adr: "docs/adr/ADR-0099-cache.md" };
    });
    expect(summary(checkDecisionGates(untested.root, untested.reg, ["platform/src"]))).toEqual(["semantic-cache:cache", "semantic-cache:decision", "semantic-cache:import"]);
    const keyed = fixture({ ...files, "platform/src/knowledge/semantic-cache.test.ts": 'it("[FO-08-35] a cached answer is re-checked for disclosure on return", () => {});\n' }, (r) => {
      addCache(r, { keyRequirement: "FO-07-42", disclosureRecheck: true, recheckTest: "platform/src/knowledge/semantic-cache.test.ts" });
      gate(r, "semantic-cache").decision = { adr: "docs/adr/ADR-0099-cache.md" };
    });
    expect(checkDecisionGates(keyed.root, keyed.reg, ["platform/src"])).toEqual([]);
  });

  it("[FO-23-08] adversarial: a Personal Agent Protocol dependency or import fails without a qualifying decision record", () => {
    const { root, reg } = fixture({
      "package.json": JSON.stringify({ name: "root", devDependencies: { "@pap/sdk": "0.1.0" } }),
      "media/src/agent.ts": 'import { connect } from "personal-agent-protocol";\nexport const c = connect;\n',
    });
    expect(summary(checkDecisionGates(root, reg, ["media/src"]))).toEqual(["personal-agent-protocol:import", "personal-agent-protocol:manifest"]);
  });
});
