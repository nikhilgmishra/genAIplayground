#!/usr/bin/env node
// Offline consistency validator for the Talkdesk configuration package and the
// docs/release sandbox pack. It proves internal consistency only; it is NOT evidence of
// any tenant capability (OPS-03).
//
// Usage: node talkdesk/tools/validate-package.mjs [--json]
// Exit code 0 when every check passes, 1 otherwise.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALWAYS_AVAILABLE_TOOLS,
  CONSEQUENTIAL_TOOLS,
  GUARDRAIL_LIMIT,
  PROHIBITED_TOOL_KINDS,
  RELEASE_DIR,
  REQUIRED_TOOLS,
  TALKDESK_DIR,
  codePointLength,
  loadSyntheticDestinations,
  loadYaml,
  readText,
  sha256Hex,
} from "./lib.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CATALOG_PLACEHOLDER = "TO_BE_PINNED_FROM_RELEASE_MANIFEST";

const PHONE_PATTERN = /(?<![\w.-])(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])|\+1\d{10}(?!\d)/g;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b\d{3}-\d{2}-\d{4}\b/,
];
const CLAIM = /HIPAA[- ]complian(t|ce)|production[- ]read(y|iness)/i;
const NEGATION = /\b(not|never|no|cannot|nor|without)\b/i;

/** NANP-style numbers that are not in the fictional 555-01xx range. */
export function findPhoneViolations(text) {
  const bad = [];
  for (const m of text.matchAll(PHONE_PATTERN)) {
    const digits = m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (!/^\d{3}55501\d{2}$/.test(digits)) bad.push(m[0]);
  }
  return bad;
}

export function findSecretMatches(text) {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map(String);
}

/** Line numbers that mention HIPAA compliance / production readiness without a negation. */
export function findUnqualifiedClaims(text) {
  const bad = [];
  text.split("\n").forEach((line, i) => {
    if (CLAIM.test(line) && !NEGATION.test(line)) bad.push(i + 1);
  });
  return bad;
}

function listFiles(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...listFiles(p, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

export function packageFiles() {
  const exts = [".md", ".yaml", ".yml", ".mjs"];
  return [...listFiles(TALKDESK_DIR, exts), ...listFiles(RELEASE_DIR, exts)];
}

/** Collects per-agent tool sets from ai-agent-config.yaml. */
export function toolsByAgent(cfg) {
  const always = (cfg.alwaysAvailableTools ?? []).map((t) => t.name);
  const map = new Map();
  const add = (id, tools, includeAlways) => {
    map.set(id, [...new Set([...(includeAlways ? always : []), ...(tools ?? []).map((t) => t.name)])]);
  };
  add(cfg.coordinator.id, cfg.coordinator.allowedTools, true);
  for (const a of cfg.agents ?? []) add(a.id, a.allowedTools, true);
  for (const s of cfg.deterministicSkills ?? []) add(s.id, s.allowedTools, false);
  return map;
}

function allToolEntries(cfg) {
  return [
    ...(cfg.alwaysAvailableTools ?? []),
    ...(cfg.coordinator?.allowedTools ?? []),
    ...(cfg.agents ?? []).flatMap((a) => a.allowedTools ?? []),
    ...(cfg.deterministicSkills ?? []).flatMap((s) => s.allowedTools ?? []),
  ];
}

/** Ids defined as the first cell of a markdown table row, e.g. "| VQ-TD-01 | ...". */
function definedIds(text, pattern) {
  const ids = new Set();
  const re = new RegExp(`^\\|\\s*(${pattern})\\b`, "gm");
  for (const m of text.matchAll(re)) ids.add(m[1]);
  return ids;
}

function referencedIds(texts, pattern) {
  const ids = new Set();
  const re = new RegExp(`\\b(${pattern})\\b`, "g");
  for (const t of texts) for (const m of t.matchAll(re)) ids.add(m[1]);
  return ids;
}

export function runChecks() {
  const results = [];
  const check = (id, fn) => {
    try {
      const detail = fn();
      results.push({ id, ok: true, detail: detail ?? "ok" });
    } catch (err) {
      results.push({ id, ok: false, detail: err.message });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const files = packageFiles();
  const texts = new Map(files.map((f) => [f, readText(f)]));
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const parsed = new Map();

  check("yaml.parse", () => {
    for (const f of yamlFiles) parsed.set(f, loadYaml(f));
    return `${yamlFiles.length} YAML files parsed`;
  });

  const agentCfg = parsed.get(path.join(TALKDESK_DIR, "ai-agent-config.yaml"));
  const expected = parsed.get(path.join(TALKDESK_DIR, "expected-config.yaml"));
  const tc = expected?.tenantConfiguration;
  const flowSpec = texts.get(path.join(TALKDESK_DIR, "studio-flow-spec.md")) ?? "";

  check("guardrail.length", () => {
    const g = agentCfg.guardrail;
    assert(typeof g.customText === "string", "customText must be a string");
    const n = codePointLength(g.customText);
    assert(/^[\x20-\x7e]+$/.test(g.customText), "guardrail text must be single-line printable ASCII so every counter agrees");
    assert(n <= GUARDRAIL_LIMIT, `guardrail text is ${n} characters (> ${GUARDRAIL_LIMIT})`);
    assert(n === g.characterCount, `recorded characterCount ${g.characterCount} != actual ${n}`);
    assert(g.limit === GUARDRAIL_LIMIT, "limit must be 300");
    return `${n} characters (limit ${GUARDRAIL_LIMIT})`;
  });

  check("guardrail.hash", () => {
    const g = agentCfg.guardrail;
    const h = sha256Hex(g.customText);
    assert(h === g.sha256, `recorded sha256 ${g.sha256} != actual ${h}`);
    assert(tc.aiAgent.guardrail.sha256 === h, "expected-config guardrail sha256 differs from ai-agent-config");
    assert(tc.aiAgent.guardrail.characterCount === g.characterCount, "expected-config guardrail characterCount differs");
    return h;
  });

  check("guardrail.exitsToStudio", () => {
    const g = agentCfg.guardrail;
    assert(g.onTrigger.requiredBehaviour === "EXIT_TO_STUDIO", "guardrail trigger must exit to Studio");
    assert(g.onTrigger.closeConversationAllowed === false, "closing the conversation must not be allowed");
    assert(agentCfg.conversationLimits.onAnyLimit.requiredBehaviour === "EXIT_TO_STUDIO", "limits must exit to Studio");
    assert(agentCfg.conversationLimits.onAnyLimit.closeConversationAllowed === false, "limits must not close");
    assert(tc.aiAgent.guardrail.onTrigger === "EXIT_TO_STUDIO" && tc.aiAgent.conversationLimits.onAnyLimit === "EXIT_TO_STUDIO", "expected-config exit behaviour mismatch");
  });

  check("versions.unknownUntilEvidenced", () => {
    const vi = agentCfg.versionIdentity;
    for (const k of ["agentConfigVersion", "model", "voice", "promptTemplates"]) {
      assert(vi[k] === "UNKNOWN" || typeof vi.evidenceRef === "string", `${k} set without evidenceRef`);
      assert(tc.aiAgent.versionIdentity[k] === "UNKNOWN" || typeof vi.evidenceRef === "string", `expected-config ${k} set without evidence`);
    }
  });

  check("catalog.pinned", () => {
    const d = agentCfg.toolCatalog.pinnedDigest;
    assert(d === CATALOG_PLACEHOLDER || SHA256.test(d), `catalogue digest must be ${CATALOG_PLACEHOLDER} or sha256 hex`);
    assert(tc.mcpConnection.toolCatalogDigest === d, "expected-config catalogue digest differs from ai-agent-config");
    assert(agentCfg.toolCatalog.dynamicToolRegistration === false && tc.mcpConnection.dynamicToolRegistration === false, "dynamic tool registration must be false");
    assert(tc.mcpConnection.endpointPath === "/mcp", "MCP endpoint path must be /mcp");
  });

  check("tools.coverage", () => {
    const entries = allToolEntries(agentCfg);
    const names = new Set(entries.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
    const extra = [...names].filter((t) => !REQUIRED_TOOLS.includes(t));
    assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);
    assert(extra.length === 0, `tools not in the spec list: ${extra.join(", ")}`);
    const versions = new Map();
    for (const t of entries) {
      assert(SEMVER.test(String(t.version)), `${t.name} version must be semver`);
      if (versions.has(t.name)) assert(versions.get(t.name) === t.version, `${t.name} listed with two versions`);
      versions.set(t.name, t.version);
    }
    return `${names.size} tools`;
  });

  check("tools.alwaysAvailable", () => {
    const always = (agentCfg.alwaysAvailableTools ?? []).map((t) => t.name).sort();
    assert(JSON.stringify(always) === JSON.stringify([...ALWAYS_AVAILABLE_TOOLS].sort()), "alwaysAvailableTools must be exactly the safety and human tools");
    for (const [id, tools] of toolsByAgent(agentCfg)) {
      if (id.endsWith("_skill")) continue;
      for (const t of ALWAYS_AVAILABLE_TOOLS) assert(tools.includes(t), `${id} lacks ${t}`);
    }
  });

  check("tools.consequentialGuarded", () => {
    for (const t of allToolEntries(agentCfg).filter((x) => CONSEQUENTIAL_TOOLS.includes(x.name))) {
      assert(t.consequential === true, `${t.name} must be consequential`);
      assert(t.requiresDeterministicConfirmation === true, `${t.name} must require deterministic confirmation`);
      assert(t.enabledInAutonomousFlow === false, `${t.name} must stay disabled until TB-02 is evidenced`);
    }
  });

  check("tools.prohibited", () => {
    const kinds = new Set(agentCfg.prohibitedToolKinds ?? []);
    for (const k of PROHIBITED_TOOL_KINDS) assert(kinds.has(k), `prohibitedToolKinds lacks ${k}`);
    const bad = /(sql|query|fetch|http|shell|exec|update_record|export)/;
    for (const t of allToolEntries(agentCfg)) assert(!bad.test(t.name), `tool name looks like a prohibited capability: ${t.name}`);
  });

  check("tools.expectedConfigMatches", () => {
    const derived = toolsByAgent(agentCfg);
    const listed = new Map((tc.aiAgent.toolsByAgent ?? []).map((e) => [e.id, e.tools ?? []]));
    assert(derived.size === listed.size, `toolsByAgent lists ${listed.size} entries, config has ${derived.size}`);
    for (const [id, tools] of derived) {
      assert(listed.has(id), `expected-config toolsByAgent lacks ${id}`);
      assert(JSON.stringify([...tools].sort()) === JSON.stringify([...listed.get(id)].sort()), `toolsByAgent mismatch for ${id}`);
    }
    const agentIds = [agentCfg.coordinator.id, ...agentCfg.agents.map((a) => a.id)];
    assert(JSON.stringify([...agentIds].sort()) === JSON.stringify([...tc.aiAgent.agents].sort()), "expected-config agents list mismatch");
  });

  const destinations = (() => {
    try {
      return loadSyntheticDestinations();
    } catch (err) {
      results.push({ id: "destinations.load", ok: false, detail: err.message });
      return null;
    }
  })();

  check("destinations.matchSyntheticWorld", () => {
    assert(destinations, "DESTINATIONS not loaded");
    const exp = tc.destinations;
    assert(exp.length === destinations.length, `expected-config has ${exp.length} destinations, DESTINATIONS has ${destinations.length}`);
    for (const d of destinations) {
      const e = exp.find((x) => x.destinationId === d.destinationId);
      assert(e, `expected-config lacks ${d.destinationId}`);
      for (const k of ["purpose", "vendorQueueRef", "fallbackDestinationIds", "languages"]) {
        assert(JSON.stringify(e[k]) === JSON.stringify(d[k]), `${d.destinationId}.${k} differs from DESTINATIONS`);
      }
      assert(e.requiresAuthentication === false, `${d.destinationId} must not require authentication`);
    }
    return `${destinations.length} destinations`;
  });

  check("destinations.flowSpecTable", () => {
    assert(destinations, "DESTINATIONS not loaded");
    for (const d of destinations) {
      const row = flowSpec.split("\n").find((l) => l.startsWith(`| \`${d.destinationId}\``));
      assert(row, `studio-flow-spec.md destination table lacks ${d.destinationId}`);
      assert(row.includes(`\`${d.vendorQueueRef}\``), `studio-flow-spec.md row for ${d.destinationId} has a different queue ref`);
      for (const fb of d.fallbackDestinationIds) assert(row.includes(`\`${fb}\``), `studio-flow-spec.md row for ${d.destinationId} lacks fallback ${fb}`);
    }
  });

  check("destinations.exitDefaultsAndChains", () => {
    const byId = new Map(tc.destinations.map((d) => [d.destinationId, d]));
    for (const [reason, id] of Object.entries(tc.exitDefaults)) assert(byId.has(id), `exitDefaults.${reason} -> unknown ${id}`);
    assert(byId.get(tc.exitDefaults.SAFETY_ROUTE).purpose === "SAFETY_PRIORITY", "SAFETY_ROUTE must default to a SAFETY_PRIORITY destination");
    assert(byId.get(tc.exitDefaults.INTERPRETER_REQUIRED).purpose === "INTERPRETER", "INTERPRETER_REQUIRED must default to INTERPRETER");
    assert(byId.get(tc.exitDefaults.CLINICAL_ROUTE).purpose === "CLINICAL_ROUTE", "CLINICAL_ROUTE must default to CLINICAL_ROUTE");
    for (const d of tc.destinations) {
      const seen = new Set([d.destinationId]);
      let frontier = [...d.fallbackDestinationIds];
      while (frontier.length) {
        const next = frontier.shift();
        assert(byId.has(next), `${d.destinationId} fallback ${next} unknown`);
        assert(!seen.has(next), `fallback cycle at ${d.destinationId} -> ${next}`);
        seen.add(next);
        frontier.push(...byId.get(next).fallbackDestinationIds);
      }
    }
  });

  check("authGate.initialisedBooleanFalse", () => {
    const v = tc.studio.variables.find((x) => x.name === "vsp_auth_gate");
    assert(v, "vsp_auth_gate variable missing");
    assert(v.type === "boolean", "vsp_auth_gate must be boolean");
    assert(v.initialValue === false, `vsp_auth_gate initial value must be boolean false, got ${JSON.stringify(v.initialValue)}`);
    assert(v.modelWritable === false && v.modelReadable === false, "vsp_auth_gate must not be model-readable or model-writable");
    for (const x of tc.studio.variables) assert(x.modelWritable === false, `${x.name} must not be model-writable`);
    const otp = tc.studio.variables.find((x) => x.name === "vsp_otp_digits");
    assert(otp && otp.enabled === false && otp.modelReadable === false, "vsp_otp_digits must be disabled and never model-readable");
  });

  check("studio.flowInvariants", () => {
    const main = tc.studio.flows.find((f) => f.flowId === "vsp_main_inbound");
    assert(main, "vsp_main_inbound missing");
    assert(main.humanRouteDependsOnGateway === false, "human route must not depend on the gateway");
    assert(main.safetyBranchRequiresAuthentication === false, "safety branch must not require authentication");
    assert(main.recordingStartsAfterStep === "SF-04", "recording must start after consent step SF-04");
    assert(main.speechInputBeforeConsent === false, "no speech input before consent");
    assert(main.humanRouteDtmf === "0", "human route DTMF must be 0");
    assert(tc.recording.startPolicy === "AFTER_CONSENT_GRANTED", "recording start policy must be AFTER_CONSENT_GRANTED");
    for (const step of main.steps) {
      const re = new RegExp(`^### ${step.replace("-", "\\-")}\\b`, "m");
      assert(re.test(flowSpec), `studio-flow-spec.md lacks a section for ${step}`);
    }
    assert(/```mermaid\n[\s\S]*?flowchart[\s\S]*?```/.test(flowSpec), "studio-flow-spec.md lacks a mermaid flowchart");
    const probe = tc.studio.flows.find((f) => f.flowId === "vsp_authgate_probe");
    assert(probe && probe.enabledInProduction === false, "auth-gate probe flow must be disabled in production");
  });

  check("studio.httpStepsMatchSpec", () => {
    for (const s of tc.studio.httpSteps) {
      const row = flowSpec.split("\n").find((l) => l.startsWith(`| ${s.ref} \``));
      assert(row, `studio-flow-spec.md section 3 lacks ${s.ref}`);
      assert(row.includes(`\`${s.operationId}\``), `${s.ref} operation id differs`);
      assert(row.includes(`\`${s.method} ${s.path}\``), `${s.ref} method/path differs from the spec table`);
      assert(s.integrationId === "talkdesk-studio-sandbox", `${s.ref} must use the telephony_control identity`);
    }
  });

  // ---- cross references -------------------------------------------------------
  const allTexts = [...texts.values()];
  const vq = texts.get(path.join(TALKDESK_DIR, "vendor-questions.md")) ?? "";
  const cg = texts.get(path.join(TALKDESK_DIR, "capability-gate.md")) ?? "";
  const ar = texts.get(path.join(RELEASE_DIR, "approval-requests.md")) ?? "";

  check("xref.vendorQuestions", () => {
    const defined = definedIds(vq, "VQ-[A-Z]+-\\d{2}");
    for (let i = 1; i <= 20; i++) assert(defined.has(`VQ-TD-${String(i).padStart(2, "0")}`), `section 5 question VQ-TD-${String(i).padStart(2, "0")} missing`);
    const missing = [...referencedIds(allTexts, "VQ-[A-Z]+-\\d{2}")].filter((x) => !defined.has(x));
    assert(missing.length === 0, `referenced but undefined: ${missing.join(", ")}`);
    return `${defined.size} questions`;
  });

  check("xref.capabilityGate", () => {
    const defined = definedIds(cg, "CG-\\d{2}");
    for (let i = 1; i <= 10; i++) assert(defined.has(`CG-${String(i).padStart(2, "0")}`), `CG-${String(i).padStart(2, "0")} missing`);
    const missing = [...referencedIds(allTexts, "CG-\\d{2}")].filter((x) => !defined.has(x));
    assert(missing.length === 0, `referenced but undefined: ${missing.join(", ")}`);
    for (const tb of ["TB-01", "TB-02", "TB-03", "TB-04", "TB-05", "TB-06", "TB-07", "TB-08", "TB-09", "TB-10"]) assert(cg.includes(tb), `capability gate does not map ${tb}`);
  });

  check("xref.approvalRequests", () => {
    const defined = new Set([...ar.matchAll(/^## (AR-\d{2})\b/gm)].map((m) => m[1]));
    assert(defined.size > 0, "no approval requests defined");
    const missing = [...referencedIds(allTexts, "AR-\\d{2}")].filter((x) => !defined.has(x));
    assert(missing.length === 0, `referenced but undefined: ${missing.join(", ")}`);
    const sections = ar.split(/^## /m).slice(1).filter((s) => /^AR-\d{2}/.test(s));
    for (const s of sections) {
      const id = s.slice(0, 5);
      for (const field of ["Scope", "Approval scope", "Owner role", "Cost estimate inputs", "Rollback", "Evidence to attach", "Remains blocked until approved"]) {
        assert(s.includes(`**${field}**`), `${id} lacks field ${field}`);
      }
    }
    return `${defined.size} approval requests`;
  });

  check("xref.testIds", () => {
    const pattern = "(?:SF-T|AG|MB|MC|DT|BS|GX|VI|EX|CC)-\\d{2}";
    const defined = new Set();
    for (const t of allTexts) for (const id of definedIds(t, pattern)) defined.add(id);
    const missing = [...referencedIds(allTexts, pattern)].filter((x) => !defined.has(x));
    assert(missing.length === 0, `test ids referenced but not defined: ${missing.join(", ")}`);
    return `${defined.size} tenant test ids defined`;
  });

  check("vendorQuestions.requiredTopics", () => {
    for (const phrase of ["256K", "1M", "Zero Retention Mode", "MCP is unavailable", "cloning", "Nova 2.5 Sonic", "Salesforce", "IdP", "AWS"]) {
      assert(vq.includes(phrase), `vendor-questions.md lacks topic: ${phrase}`);
    }
    const rows = vq.split("\n").filter((l) => /^\| VQ-/.test(l));
    for (const r of rows) assert(r.includes("UNANSWERED"), `question not marked UNANSWERED: ${r.slice(0, 40)}`);
  });

  check("release.sandboxPlan", () => {
    const plan = texts.get(path.join(RELEASE_DIR, "sandbox-plan.md")) ?? "";
    const gates = texts.get(path.join(RELEASE_DIR, "phase-gates.md")) ?? "";
    assert(plan.length > 0 && gates.length > 0, "docs/release/sandbox-plan.md and phase-gates.md must exist");
    for (const phrase of ["terraform", "destroy", "infra/terraform/envs/sandbox", "TO_BE_APPROVED_BY_FINANCE", "RATE_CARD_REQUIRED", "Exit criteria", "synthetic"]) {
      assert(plan.includes(phrase), `sandbox-plan.md lacks: ${phrase}`);
    }
    for (let p = 0; p <= 5; p++) assert(gates.includes(`Phase ${p}`), `phase-gates.md lacks Phase ${p}`);
  });

  check("release.costInputsNoInventedPrices", () => {
    const cost = parsed.get(path.join(RELEASE_DIR, "sandbox-cost-inputs.yaml"));
    assert(cost, "docs/release/sandbox-cost-inputs.yaml missing");
    let rates = 0;
    const walk = (node, p) => {
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (/^rate[A-Z]/.test(k)) {
            rates++;
            const ok = v === "RATE_CARD_REQUIRED" || (v && typeof v === "object" && v.assumption === true && v.requiresFinanceValidation === true);
            assert(ok, `${p}.${k} must be RATE_CARD_REQUIRED or a labelled assumption`);
          }
          walk(v, `${p}.${k}`);
        }
      }
    };
    walk(cost, "cost");
    assert(cost.callTestBudgetCeilingUsd === "TO_BE_APPROVED_BY_FINANCE", "call-test budget ceiling must await finance approval");
    return `${rates} rate inputs, none invented`;
  });

  // ---- hygiene ---------------------------------------------------------------
  check("hygiene.noRealPhoneNumbers", () => {
    for (const [f, t] of texts) {
      const bad = findPhoneViolations(t);
      assert(bad.length === 0, `possible real phone number in ${path.relative(TALKDESK_DIR, f)}: ${bad.join(", ")}`);
    }
  });

  check("hygiene.noSecrets", () => {
    for (const [f, t] of texts) {
      const bad = findSecretMatches(t);
      assert(bad.length === 0, `secret-like or SSN-like pattern in ${path.relative(TALKDESK_DIR, f)}: ${bad.join(", ")}`);
    }
  });

  check("hygiene.noComplianceClaims", () => {
    for (const [f, t] of texts) {
      const bad = findUnqualifiedClaims(t);
      assert(bad.length === 0, `unqualified compliance/readiness claim at ${path.relative(TALKDESK_DIR, f)} line(s) ${bad.join(", ")}`);
    }
  });

  return results;
}

function main() {
  const json = process.argv.includes("--json");
  const results = runChecks();
  if (json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  if (!json) console.log(`\n${results.length - failed}/${results.length} checks passed (internal consistency only; not tenant evidence)`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
