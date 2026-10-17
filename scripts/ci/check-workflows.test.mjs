// node --test scripts/ci/check-workflows.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lintWorkflow } from "./check-workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const good = `name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5 # pin to full commit SHA before production
      - run: echo ok
`;

test("[SPEC-15.ci] a least-privilege workflow passes", () => {
  assert.deepEqual(lintWorkflow("ci.yml", good), []);
});

test("[SPEC-15.ci] broad default permissions are rejected", () => {
  const bad = good.replace("contents: read", "contents: write");
  assert.ok(lintWorkflow("ci.yml", bad).some((p) => p.includes("top-level permissions")));
});

test("[SPEC-14.supply-chain] unpinned or unapproved actions are rejected", () => {
  assert.ok(lintWorkflow("ci.yml", good.replace(" # pin to full commit SHA before production", "")).some((p) => p.includes("SHA-pinning")));
  assert.ok(lintWorkflow("ci.yml", good.replace("actions/checkout@v5", "someone/else@v1")).some((p) => p.includes("owner not approved")));
  assert.deepEqual(lintWorkflow("ci.yml", good.replace("actions/checkout@v5 # pin to full commit SHA before production", `actions/checkout@${"a".repeat(40)}`)), []);
});

test("[SPEC-14.supply-chain] script injection through run expressions is rejected", () => {
  const bad = good.replace("run: echo ok", "run: echo ${{ github.event.pull_request.title }}");
  assert.ok(lintWorkflow("ci.yml", bad).some((p) => p.includes("untrusted expression")));
});

test("[OPS-05] deploy is workflow_dispatch only and id-token is confined", () => {
  assert.ok(lintWorkflow("deploy.yml", good).some((p) => p.includes("workflow_dispatch only")));
  const tokenJob = good.replace("    runs-on: ubuntu-24.04", "    runs-on: ubuntu-24.04\n    permissions:\n      id-token: write");
  assert.ok(lintWorkflow("ci.yml", tokenJob).some((p) => p.includes("id-token")));
  assert.ok(lintWorkflow("ci.yml", good.replace("pull_request:", "pull_request_target:")).some((p) => p.includes("pull_request_target")));
});

test("[SPEC-15.ci] the repository workflows pass the lint", () => {
  const out = execFileSync(process.execPath, [join(here, "check-workflows.mjs")], { encoding: "utf8" });
  assert.match(out, /check-workflows: ok \(3 workflows/);
});
