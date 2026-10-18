/**
 * TEST / DEVELOPMENT HELPER: makes sure policy/build holds a bundle built from
 * the current sources, running `scripts/policy.sh build` (pinned OPA) when the
 * build is missing or `sources.sha256` is stale. Tests that evaluate the WASM
 * bundle call this first so they are self-contained.
 *
 * The sources digest algorithm is identical to scripts/policy.sh
 * (`sources_digest`): sha256 over sha256sum-formatted lines for VERSION,
 * wasm-capabilities.json and every non-test *.rego / *.json under policy/vsp,
 * in byte order. A disagreement between the two implementations is reported
 * as POLICY_SOURCES_DIGEST_DIVERGED rather than silently rebuilding forever.
 *
 * If the pinned OPA binary is absent the helper throws (tests FAIL, they are
 * never skipped: an unrun test is not a PASS, OPS-03). Fetch it with
 * `bash scripts/fetch-tools.sh`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PlatformError } from "../shared/errors.js";
import { POLICY_ROOT, REPO_ROOT } from "./engine.js";

export class PolicyBundleBuildError extends PlatformError {
  constructor(
    reasonCode: string,
    /** Tail of the build tool's stderr (tool output, never request data). */
    readonly detail: string = "",
  ) {
    super(reasonCode);
  }
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** Relative paths (POSIX separators) of every file that determines the built bundle. */
export function policySourceFiles(policyRoot: string = POLICY_ROOT): string[] {
  const vsp = walk(join(policyRoot, "vsp"))
    .map((p) => relative(policyRoot, p).split(sep).join("/"))
    .filter((p) => (p.endsWith(".rego") || p.endsWith(".json")) && !p.endsWith("_test.rego"));
  return ["VERSION", "wasm-capabilities.json", ...vsp].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Same value as `bash scripts/policy.sh digest`. */
export function computeSourcesDigest(policyRoot: string = POLICY_ROOT): string {
  const listing = policySourceFiles(policyRoot)
    .map((f) => `${sha256(readFileSync(join(policyRoot, f)))}  ${f}\n`)
    .join("");
  return sha256(listing);
}

export interface BundleStatus {
  fresh: boolean;
  reasonCode: "BUNDLE_FRESH" | "BUNDLE_MISSING" | "BUNDLE_SOURCES_STALE" | "BUNDLE_DIGEST_FILE_MISMATCH";
  sourcesDigest: string;
}

export function bundleStatus(policyRoot: string = POLICY_ROOT): BundleStatus {
  const sourcesDigest = computeSourcesDigest(policyRoot);
  const build = join(policyRoot, "build");
  const required = ["bundle.tar.gz", "bundle.sha256", "sources.sha256"];
  if (required.some((f) => !existsSync(join(build, f)))) return { fresh: false, reasonCode: "BUNDLE_MISSING", sourcesDigest };
  if (readFileSync(join(build, "sources.sha256"), "utf8").trim() !== sourcesDigest) return { fresh: false, reasonCode: "BUNDLE_SOURCES_STALE", sourcesDigest };
  const recorded = readFileSync(join(build, "bundle.sha256"), "utf8").trim().split(/\s+/)[0];
  if (recorded !== sha256(readFileSync(join(build, "bundle.tar.gz")))) return { fresh: false, reasonCode: "BUNDLE_DIGEST_FILE_MISMATCH", sourcesDigest };
  return { fresh: true, reasonCode: "BUNDLE_FRESH", sourcesDigest };
}

export interface EnsureBundleResult {
  bundleDir: string;
  sourcesDigest: string;
  rebuilt: boolean;
}

export interface EnsureBundleOptions {
  repoRoot?: string;
  /** Build even when fresh. */
  force?: boolean;
  timeoutMs?: number;
}

/** Builds policy/build when needed and returns its location. Throws PolicyBundleBuildError on failure. */
export function ensurePolicyBundle(opts: EnsureBundleOptions = {}): EnsureBundleResult {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const policyRoot = join(repoRoot, "policy");
  const before = bundleStatus(policyRoot);
  if (before.fresh && !opts.force) return { bundleDir: join(policyRoot, "build"), sourcesDigest: before.sourcesDigest, rebuilt: false };
  const script = join(repoRoot, "scripts", "policy.sh");
  if (!existsSync(script)) throw new PolicyBundleBuildError("POLICY_BUILD_SCRIPT_MISSING");
  try {
    execFileSync("bash", [script, opts.force ? "rebuild" : "build"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeoutMs ?? 180_000 });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    throw new PolicyBundleBuildError("POLICY_BUNDLE_BUILD_FAILED", stderr.slice(-2000));
  }
  const after = bundleStatus(policyRoot);
  if (!after.fresh) throw new PolicyBundleBuildError(after.reasonCode === "BUNDLE_SOURCES_STALE" ? "POLICY_SOURCES_DIGEST_DIVERGED" : "POLICY_BUNDLE_BUILD_INCOMPLETE");
  return { bundleDir: join(policyRoot, "build"), sourcesDigest: after.sourcesDigest, rebuilt: true };
}
