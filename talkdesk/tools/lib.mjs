// Shared helpers for the Talkdesk configuration package validators.
//
// Offline only: no network, no Talkdesk credentials, no vendor endpoints. Uses the
// repository's existing `yaml` dependency (platform/node_modules) and Node built-ins.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TALKDESK_DIR = path.resolve(TOOLS_DIR, "..");
export const REPO_ROOT = path.resolve(TALKDESK_DIR, "..");
export const RELEASE_DIR = path.join(REPO_ROOT, "docs", "release");
export const SYNTHETIC_WORLD = path.join(REPO_ROOT, "platform", "src", "fixtures", "synthetic-world.ts");

const requireFromPlatform = createRequire(path.join(REPO_ROOT, "platform", "package.json"));
const YAML = requireFromPlatform("yaml");

export function parseYaml(text) {
  // YAML 1.2 core schema; duplicate keys are errors.
  return YAML.parse(text, { uniqueKeys: true, prettyErrors: true });
}

export function stringifyYaml(value) {
  return YAML.stringify(value, { lineWidth: 0 });
}

export function loadYaml(file) {
  return parseYaml(readFileSync(file, "utf8"));
}

export function readText(file) {
  return readFileSync(file, "utf8");
}

export function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Unicode code points, matching python3 len(str). */
export function codePointLength(text) {
  return [...text].length;
}

/**
 * Loads DESTINATIONS from the canonical synthetic world by running Node's built-in
 * TypeScript type stripping in a child process (the module has no imports).
 */
export function loadSyntheticDestinations() {
  const href = pathToFileURL(SYNTHETIC_WORLD).href;
  const script = `const m = await import(${JSON.stringify(href)}); process.stdout.write(JSON.stringify(m.DESTINATIONS));`;
  const res = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`could not load DESTINATIONS from ${SYNTHETIC_WORLD}: ${res.stderr.trim()}`);
  }
  return JSON.parse(res.stdout);
}

/** Tool names required by spec section 8 and the bounded workflow catalogue. */
export const REQUIRED_TOOLS = Object.freeze([
  "search_approved_runbook",
  "get_authorized_case_status",
  "get_appointment_options",
  "prepare_appointment_change",
  "commit_appointment_change",
  "get_invoice_status",
  "submit_billing_review",
  "create_support_request",
  "request_human_transfer",
  "get_claim_status",
  "get_provider_onboarding_status",
  "get_remittance_status",
  "submit_partner_intake",
  "submit_complaint",
  "begin_verification",
  "request_safety_route",
]);

export const ALWAYS_AVAILABLE_TOOLS = Object.freeze(["request_safety_route", "request_human_transfer"]);
export const CONSEQUENTIAL_TOOLS = Object.freeze(["commit_appointment_change", "submit_billing_review"]);
export const PROHIBITED_TOOL_KINDS = Object.freeze([
  "raw_sql",
  "arbitrary_salesforce_query",
  "arbitrary_http_fetch",
  "unrestricted_file_export",
  "shell_execution",
  "broad_crm_search",
  "generic_update_record",
]);

export const GUARDRAIL_LIMIT = 300;

// ---------------------------------------------------------------------------
// Drift comparison
// ---------------------------------------------------------------------------

/** Expected-side values that are placeholders: never a MATCH, observed facts are NEW_FACT. */
export function isExpectedPlaceholder(value) {
  if (typeof value !== "string") return false;
  return (
    value === "UNKNOWN" ||
    value === "UNDECIDED" ||
    value === "DEPENDS_ON_TB01_OPTION" ||
    value.startsWith("TO_BE_PINNED") ||
    value.startsWith("TALKDESK_QUEUE_PLACEHOLDER_")
  );
}

/** Observed-side values that mean "the operator did not observe this". */
export function isUnobserved(value) {
  return value === "UNOBSERVED" || value === "UNKNOWN" || value === undefined || value === null;
}

const ARRAY_KEY_FIELDS = ["destinationId", "flowId", "operationId", "templateId", "name", "id"];

function arrayKeyField(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (!arr.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) return null;
  for (const k of ARRAY_KEY_FIELDS) {
    if (arr.every((x) => typeof x[k] === "string")) return k;
  }
  return null;
}

/**
 * Flattens a configuration tree into path -> leaf. Arrays of objects are keyed by
 * their identifier field (e.g. destinations[dst_safety_priority].purpose); arrays
 * of scalars are leaves compared as ordered lists.
 */
export function flatten(node, prefix = "", out = new Map()) {
  if (Array.isArray(node)) {
    const key = arrayKeyField(node);
    if (key) {
      for (const item of node) {
        const p = `${prefix}[${item[key]}]`;
        for (const [k, v] of Object.entries(item)) {
          if (k === key) continue;
          flatten(v, `${p}.${k}`, out);
        }
        if (Object.keys(item).length === 1) out.set(`${p}.__present`, true);
      }
      return out;
    }
    out.set(prefix, node);
    return out;
  }
  if (node !== null && typeof node === "object") {
    const entries = Object.entries(node);
    if (entries.length === 0) {
      out.set(prefix, node);
      return out;
    }
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.set(prefix, node);
  return out;
}

/** Lists whose order carries no meaning; every other list (steps, fallback chains) is ordered. */
const UNORDERED_LIST_SUFFIXES = [".tools", ".languages", ".humanRoutePhrases", ".agents", ".deterministicSkills", ".writtenBy"];

function sameLeaf(a, b, leafPath = "") {
  if (Array.isArray(a) && Array.isArray(b) && UNORDERED_LIST_SUFFIXES.some((s) => leafPath.endsWith(s))) {
    const norm = (x) => JSON.stringify([...x].map((v) => JSON.stringify(v)).sort());
    return norm(a) === norm(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Builds the operator transcription template from an expected tenantConfiguration. */
export function toObservationTemplate(node, pathHint = "") {
  if (Array.isArray(node)) {
    const key = arrayKeyField(node);
    if (!key) return "UNOBSERVED";
    return node.map((item) => {
      const o = { [key]: item[key] };
      for (const [k, v] of Object.entries(item)) {
        if (k === key) continue;
        // Studio prompt texts are transcribed exactly; drift-check derives textSha256.
        if (pathHint === ".templates" && k === "textSha256") o.observedText = "UNOBSERVED";
        else o[k] = toObservationTemplate(v, `${pathHint}.${k}`);
      }
      return o;
    });
  }
  if (node !== null && typeof node === "object") {
    if (pathHint === ".aiAgent.guardrail") {
      // The operator transcribes the guardrail text exactly; hash and count are derived.
      const o = { observedText: "UNOBSERVED" };
      for (const [k, v] of Object.entries(node)) {
        if (k === "sha256" || k === "characterCount") continue;
        o[k] = toObservationTemplate(v, `${pathHint}.${k}`);
      }
      return o;
    }
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = toObservationTemplate(v, `${pathHint}.${k}`);
    return o;
  }
  return "UNOBSERVED";
}

/**
 * Compares expected vs observed tenantConfiguration trees.
 * Statuses: MATCH, DRIFT, UNEXPECTED, NEW_FACT, UNOBSERVED, NOT_RECORDED.
 * Verdict: DRIFT if any DRIFT/UNEXPECTED; INCOMPLETE if anything is not a MATCH;
 * CLEAN only when every expected leaf MATCHes. INCOMPLETE is never a pass (OPS-03).
 */
export function compareConfig(expectedTree, observedTree) {
  const observed = structuredClone(observedTree ?? {});
  // Derive guardrail hash/count from transcribed text.
  const g = observed?.aiAgent?.guardrail;
  if (g && typeof g === "object") {
    if (typeof g.observedText === "string" && !isUnobserved(g.observedText)) {
      g.sha256 = sha256Hex(g.observedText);
      g.characterCount = codePointLength(g.observedText);
    } else {
      g.sha256 = "UNOBSERVED";
      g.characterCount = "UNOBSERVED";
    }
    delete g.observedText;
  }
  if (Array.isArray(observed?.templates)) {
    for (const t of observed.templates) {
      if (t === null || typeof t !== "object" || !("observedText" in t)) continue;
      t.textSha256 = typeof t.observedText === "string" && !isUnobserved(t.observedText) ? sha256Hex(t.observedText) : "UNOBSERVED";
      delete t.observedText;
    }
  }
  const exp = flatten(expectedTree ?? {});
  const obs = flatten(observed);
  const rows = [];
  for (const [p, ev] of exp) {
    if (!obs.has(p)) {
      rows.push({ path: p, status: "NOT_RECORDED", expected: ev, observed: undefined });
      continue;
    }
    const ov = obs.get(p);
    let status;
    if (isUnobserved(ov)) status = "UNOBSERVED";
    else if (isExpectedPlaceholder(ev)) status = "NEW_FACT";
    else if (sameLeaf(ev, ov, p)) status = "MATCH";
    else status = "DRIFT";
    rows.push({ path: p, status, expected: ev, observed: ov });
  }
  for (const [p, ov] of obs) {
    if (!exp.has(p)) rows.push({ path: p, status: "UNEXPECTED", expected: undefined, observed: ov });
  }
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const verdict =
    (counts.DRIFT ?? 0) + (counts.UNEXPECTED ?? 0) > 0
      ? "DRIFT"
      : rows.every((r) => r.status === "MATCH")
        ? "CLEAN"
        : "INCOMPLETE";
  return { verdict, counts, rows };
}

/** Checks proposed telephony-control operations against a gateway OpenAPI document. */
export function compareOpenApi(httpSteps, openapi) {
  const paths = openapi?.paths ?? {};
  return (httpSteps ?? []).map((s) => {
    const entry = paths[s.path];
    const found = Boolean(entry && entry[String(s.method).toLowerCase()]);
    return { operationId: s.operationId, method: s.method, path: s.path, status: found ? "OPENAPI_MATCH" : "OPENAPI_MISSING" };
  });
}
