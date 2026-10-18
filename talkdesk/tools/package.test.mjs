// Offline tests for the Talkdesk configuration package (node:test, no dependencies beyond
// the repository's existing `yaml`). Titles carry requirement tags for traceability.
// These prove internal consistency of repository artefacts only — they are not evidence
// of any Talkdesk tenant capability (OPS-03).
//
// Run: node --test talkdesk/tools/package.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { emitTemplate } from "./drift-check.mjs";
import {
  ALWAYS_AVAILABLE_TOOLS,
  CONSEQUENTIAL_TOOLS,
  GUARDRAIL_LIMIT,
  RELEASE_DIR,
  REQUIRED_TOOLS,
  TALKDESK_DIR,
  codePointLength,
  compareConfig,
  compareOpenApi,
  loadGatewayOpenApi,
  loadSyntheticDestinations,
  loadToolCatalog,
  loadYaml,
  parseYaml,
  readText,
  sha256Hex,
  toObservationTemplate,
} from "./lib.mjs";
import {
  catalogAssignmentViolations,
  findPhoneViolations,
  findSecretMatches,
  findUnqualifiedClaims,
  packageFiles,
  publishedStepViolations,
  runChecks,
  toolsByAgent,
} from "./validate-package.mjs";

const agentCfg = loadYaml(path.join(TALKDESK_DIR, "ai-agent-config.yaml"));
const expected = loadYaml(path.join(TALKDESK_DIR, "expected-config.yaml"));
const tc = expected.tenantConfiguration;
const doc = (name) => readText(path.join(TALKDESK_DIR, name));

/** Deep copy of the expected tree with every placeholder replaced, i.e. a "perfect" observation. */
function perfectObservation(tree) {
  const obs = structuredClone(tree);
  obs.aiAgent.guardrail = { observedText: agentCfg.guardrail.customText, onTrigger: tree.aiAgent.guardrail.onTrigger };
  obs.templates = tree.templates.map((t) => ({ templateId: t.templateId, observedText: `approved text for ${t.templateId}` }));
  return obs;
}

describe("validator", () => {
  it("[OPS-03] every package consistency check passes (internal consistency only)", () => {
    const failed = runChecks().filter((r) => !r.ok);
    assert.deepEqual(failed, []);
  });
});

describe("guardrail", () => {
  it("[SPEC-2.guardrail] custom guardrail text is <= 300 characters and its recorded count and sha256 are exact", () => {
    const text = agentCfg.guardrail.customText;
    assert.ok(codePointLength(text) <= GUARDRAIL_LIMIT);
    assert.equal(codePointLength(text), agentCfg.guardrail.characterCount);
    assert.equal(Buffer.byteLength(text, "utf8"), agentCfg.guardrail.characterCount, "ASCII: bytes == characters");
    assert.equal(sha256Hex(text), agentCfg.guardrail.sha256);
    assert.equal(tc.aiAgent.guardrail.sha256, agentCfg.guardrail.sha256);
  });

  it("[SAFE-03] guardrail trigger and conversation limits exit to Studio and never close the conversation", () => {
    assert.equal(agentCfg.guardrail.onTrigger.requiredBehaviour, "EXIT_TO_STUDIO");
    assert.equal(agentCfg.guardrail.onTrigger.closeConversationAllowed, false);
    assert.equal(agentCfg.conversationLimits.onAnyLimit.requiredBehaviour, "EXIT_TO_STUDIO");
    assert.equal(agentCfg.conversationLimits.onAnyLimit.closeConversationAllowed, false);
    for (const k of ["refusalCountLimit", "silenceTimeout", "maxTurns"]) assert.equal(agentCfg.conversationLimits[k], "UNKNOWN", `${k} is not invented`);
  });

  it("[SPEC-2.guardrail] guardrail text names the safety and human tools and states guardrails are not the security boundary", () => {
    assert.match(agentCfg.guardrail.customText, /request_safety_route/);
    assert.match(agentCfg.guardrail.customText, /request_human_transfer/);
    assert.match(readText(path.join(TALKDESK_DIR, "ai-agent-config.yaml")), /guardrails are NOT the\s*\n?#?\s*security boundary/i);
  });
});

describe("tools", () => {
  it("[SPEC-8.tools] tool assignment covers exactly the spec tool list with semver versions", () => {
    const names = new Set([...toolsByAgent(agentCfg).values()].flat());
    assert.deepEqual([...names].sort(), [...REQUIRED_TOOLS].sort());
  });

  it("[OPS-06] [SPEC-8.tools] every pinned catalogue tool (incl. get_login_guidance, prepare_billing_review) is assigned to exactly one agent at its pinned version", () => {
    const catalog = loadToolCatalog();
    assert.ok(catalog.some((t) => t.name === "get_login_guidance") && catalog.some((t) => t.name === "prepare_billing_review"));
    assert.deepEqual(catalogAssignmentViolations(agentCfg, catalog), []);
    const billing = agentCfg.agents.find((a) => a.id === "vsp_billing_claims").allowedTools.map((x) => x.name);
    assert.ok(billing.indexOf("prepare_billing_review") < billing.indexOf("submit_billing_review"), "prepare precedes submit");
    // Negative controls: a tool listed twice, a missing tool and a version mismatch are all reported.
    const twice = structuredClone(agentCfg);
    twice.coordinator.allowedTools.push({ name: "get_invoice_status", version: "1.0.0" });
    assert.match(catalogAssignmentViolations(twice, catalog).join("|"), /get_invoice_status must be assigned to exactly one/);
    const missing = structuredClone(agentCfg);
    missing.coordinator.allowedTools = missing.coordinator.allowedTools.filter((x) => x.name !== "get_login_guidance");
    assert.match(catalogAssignmentViolations(missing, catalog).join("|"), /catalogue tool without an agent: get_login_guidance/);
    const version = structuredClone(agentCfg);
    version.agents[0].allowedTools[0].version = "9.9.9";
    assert.ok(catalogAssignmentViolations(version, catalog).some((m) => m.includes("catalogue pins")));
  });

  it("[SAFE-02] safety and human tools are available to every LLM agent", () => {
    for (const [id, tools] of toolsByAgent(agentCfg)) {
      if (id.endsWith("_skill")) continue;
      for (const t of ALWAYS_AVAILABLE_TOOLS) assert.ok(tools.includes(t), `${id} lacks ${t}`);
    }
  });

  it("[ACT-01] consequential tools require deterministic confirmation and stay disabled until TB-02 is evidenced", () => {
    const entries = [...agentCfg.agents.flatMap((a) => a.allowedTools)].filter((t) => CONSEQUENTIAL_TOOLS.includes(t.name));
    assert.equal(entries.length, CONSEQUENTIAL_TOOLS.length);
    for (const t of entries) {
      assert.equal(t.requiresDeterministicConfirmation, true);
      assert.equal(t.enabledInAutonomousFlow, false);
    }
    const skill = agentCfg.deterministicSkills.find((s) => s.id === "vsp_confirmation_skill");
    assert.equal(skill.status, "DISABLED_UNTIL_TB02_PROVEN");
  });

  it("[OPS-06] model, voice, agent and prompt versions are UNKNOWN and the catalogue digest awaits the release manifest", () => {
    for (const k of ["agentConfigVersion", "model", "voice", "promptTemplates"]) assert.equal(agentCfg.versionIdentity[k], "UNKNOWN");
    assert.equal(agentCfg.toolCatalog.pinnedDigest, "TO_BE_PINNED_FROM_RELEASE_MANIFEST");
    assert.equal(agentCfg.toolCatalog.dynamicToolRegistration, false);
  });
});

describe("studio flow", () => {
  it("[SAFE-05] Studio destination allowlist equals DESTINATIONS from the synthetic world", () => {
    const destinations = loadSyntheticDestinations();
    const pick = (d) => ({ id: d.destinationId, purpose: d.purpose, ref: d.vendorQueueRef, fb: d.fallbackDestinationIds, lang: d.languages });
    assert.deepEqual(tc.destinations.map(pick), destinations.map(pick));
  });

  it("[SAFE-02] safety destinations and the safety branch never require authentication", () => {
    for (const d of tc.destinations) assert.equal(d.requiresAuthentication, false);
    const main = tc.studio.flows.find((f) => f.flowId === "vsp_main_inbound");
    assert.equal(main.safetyBranchRequiresAuthentication, false);
    assert.equal(tc.destinations.find((d) => d.destinationId === tc.exitDefaults.SAFETY_ROUTE).purpose, "SAFETY_PRIORITY");
    assert.match(doc("studio-flow-spec.md"), /### SF-S Early safety branch \(priority, no authentication\)/);
  });

  it("[SPEC-3.independent-route] the human route has no gateway dependency and is reachable by DTMF 0 and 'agent'", () => {
    const main = tc.studio.flows.find((f) => f.flowId === "vsp_main_inbound");
    assert.equal(main.humanRouteDependsOnGateway, false);
    assert.equal(main.humanRouteDtmf, "0");
    assert.deepEqual(main.humanRoutePhrases, ["agent"]);
    assert.match(doc("studio-flow-spec.md"), /### SF-H Independent human route \(no AI, gateway or policy dependency\)/);
  });

  it("[DATA-03] recording starts only after the consent step and no speech is captured before consent", () => {
    const main = tc.studio.flows.find((f) => f.flowId === "vsp_main_inbound");
    assert.equal(main.recordingStartsAfterStep, "SF-04");
    assert.equal(main.speechInputBeforeConsent, false);
    assert.equal(tc.recording.startPolicy, "AFTER_CONSENT_GRANTED");
    assert.ok(main.steps.indexOf("SF-04") < main.steps.indexOf("SF-06"), "consent precedes session creation and AI admission");
  });

  it("[AUTH-07] the Auth Gate variable is initialised to boolean false, never a string, null or empty value", () => {
    const raw = readText(path.join(TALKDESK_DIR, "expected-config.yaml"));
    const v = parseYaml(raw).tenantConfiguration.studio.variables.find((x) => x.name === "vsp_auth_gate");
    assert.equal(typeof v.initialValue, "boolean");
    assert.equal(v.initialValue, false);
    assert.equal(v.modelWritable, false);
    assert.equal(v.modelReadable, false);
  });

  it("[AUTH-06] the OTP digits variable is disabled until TB-03 and never model-readable", () => {
    const v = tc.studio.variables.find((x) => x.name === "vsp_otp_digits");
    assert.equal(v.enabled, false);
    assert.equal(v.modelReadable, false);
    assert.match(doc("studio-flow-spec.md"), /Pausing the\s+recorder alone is insufficient|pausing the recorder alone is insufficient/i);
  });

  it("[AUTH-03] no Studio variable is model-writable", () => {
    for (const v of tc.studio.variables) assert.equal(v.modelWritable, false, v.name);
  });
});

describe("auth gate matrix", () => {
  it("[AUTH-07] the matrix covers missing, null, false, string values, expiry, reuse, generation change and gateway authority", () => {
    const text = doc("auth-gate.md");
    const rows = text.split("\n").filter((l) => /^\| AG-\d{2} /.test(l));
    assert.ok(rows.length >= 19);
    const has = (re) => assert.ok(rows.some((r) => re.test(r)), `no AG row matches ${re}`);
    has(/missing/);
    has(/`null`/);
    has(/boolean `false`/);
    has(/string `"false"`/);
    has(/string `"true"`/);
    has(/expires mid-call/);
    has(/reuse across calls/);
    has(/generation change after participant change/);
    has(/POLICY_DENIED/);
    assert.match(text, /Gateway enforcement is authoritative regardless of the gate/);
  });
});

describe("drift check", () => {
  it("[OPS-03] the unfilled observation template is INCOMPLETE, never CLEAN", () => {
    const tpl = parseYaml(emitTemplate(path.join(TALKDESK_DIR, "expected-config.yaml")));
    const r = compareConfig(tc, tpl.tenantConfiguration);
    assert.equal(r.verdict, "INCOMPLETE");
    assert.equal(r.counts.MATCH ?? 0, 0);
  });

  it("[SPEC-15.drift] the committed observation template matches the generator output", () => {
    const committed = readText(path.join(TALKDESK_DIR, "observed-config.template.yaml"));
    assert.equal(committed, emitTemplate(path.join(TALKDESK_DIR, "expected-config.yaml")));
  });

  it("[OPS-03] observed values for placeholder fields are NEW_FACT, not MATCH, so the verdict stays INCOMPLETE", () => {
    const obs = perfectObservation(tc);
    obs.destinations[0].vendorQueueRef = "tenant-queue-safety-001";
    const r = compareConfig(tc, obs);
    const row = r.rows.find((x) => x.path === "destinations[dst_safety_priority].vendorQueueRef");
    assert.equal(row.status, "NEW_FACT");
    assert.equal(r.verdict, "INCOMPLETE");
  });

  it("[SPEC-15.drift] a changed fallback chain and an altered guardrail text are DRIFT", () => {
    const obs = perfectObservation(tc);
    obs.destinations.find((d) => d.destinationId === "dst_safety_priority").fallbackDestinationIds = ["dst_support_general"];
    obs.aiAgent.guardrail.observedText = agentCfg.guardrail.customText.replace("Never", "Rarely");
    const r = compareConfig(tc, obs);
    const status = (p) => r.rows.find((x) => x.path === p)?.status;
    assert.equal(status("destinations[dst_safety_priority].fallbackDestinationIds"), "DRIFT");
    assert.equal(status("aiAgent.guardrail.sha256"), "DRIFT");
    assert.equal(r.verdict, "DRIFT");
  });

  it("[SPEC-15.drift] the exact guardrail text MATCHes on hash and character count", () => {
    const r = compareConfig(tc, perfectObservation(tc));
    const status = (p) => r.rows.find((x) => x.path === p)?.status;
    assert.equal(status("aiAgent.guardrail.sha256"), "MATCH");
    assert.equal(status("aiAgent.guardrail.characterCount"), "MATCH");
  });

  it("[SPEC-15.drift] an observed field absent from the expected definition is UNEXPECTED and fails the check", () => {
    const obs = perfectObservation(tc);
    obs.studio.flows[0].extraBypassRoute = "dial-anything";
    const r = compareConfig(tc, obs);
    assert.equal(r.rows.find((x) => x.path === "studio.flows[vsp_main_inbound].extraBypassRoute").status, "UNEXPECTED");
    assert.equal(r.verdict, "DRIFT");
  });

  it("[SPEC-15.drift] CLEAN is reported only when every expected field MATCHes", () => {
    const exp = { a: { b: 1, list: ["x", "y"] }, rows: [{ id: "r1", v: true }], tools: ["t1", "t2"] };
    assert.equal(compareConfig(exp, structuredClone(exp)).verdict, "CLEAN");
    const missing = structuredClone(exp);
    delete missing.a.b;
    assert.equal(compareConfig(exp, missing).verdict, "INCOMPLETE");
  });

  it("[SPEC-15.drift] tool lists compare as sets while fallback chains stay ordered", () => {
    const obs = perfectObservation(tc);
    const agent = obs.aiAgent.toolsByAgent.find((a) => a.id === "vsp_scheduling");
    agent.tools = [...agent.tools].reverse();
    const ordered = { chain: { fallbackDestinationIds: ["a", "b"] } };
    const r1 = compareConfig(tc, obs);
    assert.equal(r1.rows.find((x) => x.path === "aiAgent.toolsByAgent[vsp_scheduling].tools").status, "MATCH");
    const r2 = compareConfig(ordered, { chain: { fallbackDestinationIds: ["b", "a"] } });
    assert.equal(r2.verdict, "DRIFT");
  });

  it("[SPEC-15.drift] the OpenAPI comparison reports telephony-control operations missing from the gateway document", () => {
    const steps = tc.studio.httpSteps;
    const openapi = { paths: { "/telephony/v1/calls": { post: {} } } };
    const r = compareOpenApi(steps, openapi);
    assert.equal(r.find((x) => x.operationId === "telephony.startCall").status, "OPENAPI_MATCH");
    assert.equal(r.find((x) => x.operationId === "telephony.authGate").status, "OPENAPI_MISSING");
  });

  it("[SPEC-15.drift] [SPEC-6.no-phi-in-urls] Studio HTTP steps equal the gateway's published OpenAPI: paths, operation ids, header-only session reference", () => {
    const openapi = loadGatewayOpenApi();
    assert.deepEqual(publishedStepViolations(tc.studio.httpSteps, openapi), []);
    assert.ok(compareOpenApi(tc.studio.httpSteps, openapi).every((r) => r.status === "OPENAPI_MATCH"));
    for (const s of tc.studio.httpSteps) assert.ok(!s.path.includes("{sessionRef}"), `${s.ref} keeps the session reference out of the URL`);
    assert.equal(tc.studio.httpSteps.find((s) => s.ref === "TC-09").operationId, "webhooks.transferEvents");
    // Negative controls: the earlier proposed URL form and a dropped header are reported.
    const old = structuredClone(tc.studio.httpSteps);
    old.find((s) => s.ref === "TC-04").path = "/telephony/v1/calls/{sessionRef}/auth-gate";
    old.find((s) => s.ref === "TC-12").sessionRefHeader = "NONE";
    const bad = publishedStepViolations(old, openapi).join("|");
    assert.match(bad, /TC-04 GET \/telephony\/v1\/calls\/\{sessionRef\}\/auth-gate differs/);
    assert.match(bad, /TC-12 sessionRefHeader differs/);
    assert.match(publishedStepViolations(old.filter((s) => s.ref !== "TC-07"), openapi).join("|"), /published TC-07 missing/);
  });

  it("[AUTH-03] [SPEC-7.session-binding] one integrationId per Talkdesk tenant: MCP and telephony-control credentials differ by channel only", () => {
    const id = tc.mcpConnection.integrationId;
    assert.equal(tc.mcpConnection.channel, "mcp_tools");
    for (const s of tc.studio.httpSteps) {
      assert.equal(s.integrationId, id, s.ref);
      assert.equal(s.channel, s.ref === "TC-09" ? "webhook" : "telephony_control", s.ref);
    }
    assert.match(doc("mcp-connection.md"), /One `integrationId` per Talkdesk tenant/);
  });

  it("[SPEC-15.drift] the template keeps identifier keys and asks for guardrail text rather than its hash", () => {
    const tpl = toObservationTemplate(tc, "");
    assert.equal(tpl.destinations[0].destinationId, "dst_safety_priority");
    assert.equal(tpl.destinations[0].vendorQueueRef, "UNOBSERVED");
    assert.equal(tpl.aiAgent.guardrail.observedText, "UNOBSERVED");
    assert.equal(tpl.aiAgent.guardrail.sha256, undefined);
    assert.equal(tpl.templates[0].observedText, "UNOBSERVED");
  });
});

describe("registers and release pack", () => {
  it("[SPEC-5.vendor-questions] the register reproduces every section 5 Talkdesk question and marks all UNANSWERED", () => {
    const text = doc("vendor-questions.md");
    const required = [
      "PHI path and subprocessors",
      "model and voice identifiers",
      "storage and training terms",
      "residency and any cross-border routing",
      "retention and deletion",
      "raw audio and transcripts",
      "recording-consent controls",
      "secure DTMF or portal verification",
      "export formats",
      "per-tenant quotas",
      "throttling and queue behaviour",
      "version pinning",
      "rollback",
      "emergency routing",
      "support response commitments",
      "authentication variables be cleared on expiry",
      "model mutate any trusted session field",
      "every protected utterance be validated before audio emission",
      "crisis input available",
      "actual plan (not a demo tenant)",
    ];
    for (const phrase of required) assert.ok(text.includes(phrase), `missing: ${phrase}`);
    for (const row of text.split("\n").filter((l) => /^\| VQ-/.test(l))) assert.match(row, /UNANSWERED/);
  });

  it("[SPEC-2.vendor-claims] ElevenLabs and Nova 2.5 Sonic caveats are recorded as open questions", () => {
    const text = doc("vendor-questions.md");
    assert.match(text, /MCP is unavailable for users requiring HIPAA[ ]compliance or Zero Retention Mode/);
    assert.match(text, /Voice-cloning workflows are not ZRM-eligible/);
    assert.match(text, /256K vs model overview up to 1M/);
  });

  it("[OPS-05] every approval request states scope, cost inputs, rollback, owner, evidence and blocked items", () => {
    const text = readText(path.join(RELEASE_DIR, "approval-requests.md"));
    const sections = text.split(/^## /m).filter((s) => /^AR-\d{2}/.test(s));
    assert.ok(sections.length >= 10);
    for (const s of sections) {
      for (const f of ["Scope", "Approval scope", "Owner role", "Cost estimate inputs", "Rollback", "Evidence to attach", "Remains blocked until approved"]) {
        assert.ok(s.includes(`**${f}**`), `${s.slice(0, 5)} lacks ${f}`);
      }
    }
    assert.match(text, /Not requested in Phase 2: `PHI_PROCESSING`/);
  });

  it("[OPS-05] cost inputs contain no invented prices and the call-test ceiling awaits finance", () => {
    const cost = loadYaml(path.join(RELEASE_DIR, "sandbox-cost-inputs.yaml"));
    const rates = [];
    const walk = (n) => {
      if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { if (/^rate[A-Z]/.test(k)) rates.push(v); walk(v); }
    };
    walk(cost);
    assert.ok(rates.length > 20);
    for (const r of rates) assert.equal(r, "RATE_CARD_REQUIRED");
    assert.equal(cost.callTestBudgetCeilingUsd, "TO_BE_APPROVED_BY_FINANCE");
    for (const s of cost.callTestPlan.suites) {
      assert.equal(s.calls.assumption, true);
      assert.equal(s.calls.requiresFinanceValidation, true);
    }
  });

  it("[SPEC-2.simulator] the runbook forbids LLM-generated voice scenarios and requires version proof per run", () => {
    const text = doc("simulator-and-evaluation-runbook.md");
    assert.match(text, /No LLM-generated voice scenarios/);
    assert.match(text, /Proving which version each run exercises/);
    assert.match(text, /Batch Agent Evaluation \(Preview\)/);
    assert.match(text, /executionMode: vendor_sandbox/);
  });
});

describe("hygiene", () => {
  it("[DATA-01] package files contain no real phone numbers, secrets or SSN-like values", () => {
    for (const f of packageFiles()) {
      const t = readText(f);
      assert.deepEqual(findPhoneViolations(t), [], f);
      assert.deepEqual(findSecretMatches(t), [], f);
    }
  });

  it("[DATA-01] the scanners detect non-fictional numbers and secret-shaped values (negative control)", () => {
    // Built at runtime so the samples never appear literally in a package file.
    const realLooking = ["212", "867", "5309"].join("-");
    assert.deepEqual(findPhoneViolations(`call ${realLooking} or +1 555 555 0101`), [realLooking]);
    assert.ok(findSecretMatches(`key ${"AKIA" + "ABCDEFGHIJKLMNOP"}`).length > 0);
    assert.deepEqual(findSecretMatches("no secrets here"), []);
  });

  it("[SPEC-16.no-claims] no file makes an unqualified HIPAA-compliance or production-readiness claim", () => {
    for (const f of packageFiles()) assert.deepEqual(findUnqualifiedClaims(readText(f)), [], f);
    assert.deepEqual(findUnqualifiedClaims(`The system is ${"HIPAA"} ${"compliant"}.`), [1], "negative control");
  });
});
