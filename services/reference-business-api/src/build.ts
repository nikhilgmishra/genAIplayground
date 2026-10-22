/**
 * The code digest of the running service (WP-23): SHA-256 over the names and contents of its source modules (tests
 * excluded), in name order. The fault-control listener reports it (`GET /__admin/build`) so a Layer-2 suite can
 * refuse to run against a container that still serves an older checkout of the service (the local composition runs
 * the checkout's code from a bind mount: a change needs the container recreated). `platform/test/integration/domain`
 * computes the same digest over the checkout.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CODE_DIGEST_SCHEME = "refbiz.code.v1";

/** The digest of the service sources in `dir` (`*.ts`, without `*.test.ts`). */
export function codeDigestOf(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  const h = createHash("sha256").update(`${CODE_DIGEST_SCHEME}\n`);
  for (const f of files) h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex");
}
