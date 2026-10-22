import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AdminDeps } from "./admin.js";
import { buildAdminApp } from "./admin.js";
import { codeDigestOf } from "./build.js";
import { fenceDigest, KEYED_WRITE_OPERATIONS } from "./changes.js";
import { FaultBoard } from "./faults.js";
import { requestDigest } from "./ids.js";

describe("code digest of the running service [FO-06-74]", () => {
  it("[FO-06-74] covers every source module by name and content, never the tests; any change moves it", () => {
    const dir = mkdtempSync(join(tmpdir(), "refbiz-build-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
      const d1 = codeDigestOf(dir);
      expect(d1).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(dir, "a.test.ts"), "test file\n");
      writeFileSync(join(dir, "notes.md"), "not code\n");
      expect(codeDigestOf(dir)).toBe(d1);
      writeFileSync(join(dir, "b.ts"), "export const b = 3;\n");
      const d2 = codeDigestOf(dir);
      expect(d2).not.toBe(d1);
      writeFileSync(join(dir, "c.ts"), "");
      expect(codeDigestOf(dir)).not.toBe(d2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[FO-06-74] the fault-control listener reports the digest it was started with", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = buildAdminApp({ codeDigest: codeDigestOf(here), faults: new FaultBoard() } as unknown as AdminDeps);
    try {
      const r = await app.inject({ method: "GET", url: "/__admin/build", headers: { host: "127.0.0.1" } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ codeDigest: codeDigestOf(here) });
    } finally {
      await app.close();
    }
  });
});

describe("fence rows never match a request [ACT-03]", () => {
  it("[ACT-03] the stored digest of a fence is domain-separated from every request digest of its operation", () => {
    for (const op of KEYED_WRITE_OPERATIONS) {
      const f = fenceDigest(op);
      expect(f).toMatch(/^[0-9a-f]{64}$/);
      expect(f).not.toBe(requestDigest(op, {}));
      expect(f).not.toBe(fenceDigest(KEYED_WRITE_OPERATIONS.find((o) => o !== op) as string));
    }
  });
});
