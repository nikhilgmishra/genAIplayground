/**
 * Temporary directories for Layer-2 tests. Each one is removed when the test that created it
 * finishes, whether it passed or failed, so repeated runs leave nothing behind in the temp directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Creates `<tmpdir>/<prefix>XXXXXX`; call it inside a test body. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
