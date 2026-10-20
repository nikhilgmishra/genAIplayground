/**
 * Failure-injection tests at the actual endpoint for the invariants the invariant register lists without one
 * (FO-19-05 / FO-02-28: AUTH-03, AUTH-05, DATA-01, DATA-04, ACT-04, SAFE-01, SAFE-05, OPS-04, OPS-06; plus
 * OPS-05). Each test injects a failure into a dependency of the REAL local composition (full container: OPA WASM
 * policy, PGlite, the gateway over loopback HTTP with the MCP SDK client, Studio telephony-control routes,
 * worker loops) and asserts that the invariant still holds, from backend records.
 *
 * Injection methods (all labelled; none changes production code):
 *  - the LOCAL FIXTURE fault injector of the adapters (`c.fixtures.faults`: OUTAGE, TIMEOUT_BEFORE_SEND, ...);
 *  - a test-scoped replacement of one dependency method on the composed instance (restored in `finally`),
 *    where the fault injector has no matching kind (a store read that throws, an error carrying PHI text, a
 *    memory store returning a forged recap, a key resolver that fails);
 *  - startup inputs (config guard) and manifest inputs for OPS-04 / OPS-05 / OPS-06, whose endpoint is the
 *    startup guard and the release manifest rather than a call.
 * SYNTHETIC data only. Titles carry `[FAILURE:<invariant>]` (the invariant register's failure-injection role).
 */
import type { KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDeployableConfig } from "../../src/config/startup.js";
import { buildReleaseManifest, UNPINNED_DIGEST } from "../../src/evaluation/manifest.js";
import { APPOINTMENTS, DESTINATIONS, ORGANIZATIONS, PEOPLE, REMITTANCES } from "../../src/fixtures/synthetic-world.js";
import type { SyntheticPerson } from "../../src/fixtures/synthetic-world.js";
import { kvKeys, sessionRefHash } from "../../src/identity/keys.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { FakeClock } from "../../src/shared/clock.js";
import { ConfigurationRejectedError } from "../../src/shared/errors.js";
import { AVERY, RILEY, createJourneyHarness } from "../journeys/harness.js";
import type { JourneyCall, JourneyHarness } from "../journeys/harness.js";

const APPT = APPOINTMENTS[0].appointmentId;
const READ_ARGS = { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" } as const;
const ALLOWLIST = new Set<string>(DESTINATIONS.map((d) => d.destinationId));

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function verified(person: SyntheticPerson = AVERY, hint = "avery.synthetic", role: "client" | "practice_staff" = "client"): Promise<JourneyCall> {
  const call = h.call();
  await call.start();
  await call.role(role);
  expect((await call.verify(person, hint)).bound).toBe(true);
  return call;
}

/** Replaces one method of a composed instance for the duration of `fn` (test-scoped failure injection). */
async function replaced<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K], fn: () => Promise<void>): Promise<void> {
  const original = obj[key];
  (obj as Record<K, T[K]>)[key] = impl;
  try {
    await fn();
  } finally {
    (obj as Record<K, T[K]>)[key] = original;
  }
}

const deniedOrFailed = new Set(["POLICY_DENIED", "PERMANENT_FAILURE", "RETRYABLE_FAILURE"]);

describe("[FO-19-05][FO-02-28] failure injection at the endpoint", () => {
  it("[FAILURE:AUTH-01][AUTH-01] the secure-link notification channel and the identity directory fail: the session stays unauthenticated; caller ID and spoken identifiers never stand in", async () => {
    // Its own container: the failed attempts spend the account's verification throttles, which other cases must not inherit.
    const own = await createJourneyHarness({ ingestKnowledge: false });
    try {
      await authFailure(own);
    } finally {
      await own.close();
    }
  }, 180_000);

  async function authFailure(h: JourneyHarness): Promise<void> {
    const call = h.call();
    await call.start();
    await call.role("client");
    // The LOCAL FIXTURE identity adapters' own failure switches (the notification provider is down; the directory is unavailable).
    const switches: [string, (on: boolean) => void][] = [
      ["notifications", (on) => h.c.identity.notifications.setFailing(on)],
      ["identity-directory", (on) => h.c.identity.directory.setUnavailable(on)],
    ];
    for (const [name, set] of switches) {
      set(true);
      try {
        const v = await call.verify(AVERY, "avery.synthetic");
        expect(v.bound, name).toBe(false);
        expect(await call.authGate()).toBe(false);
        const r = await call.tool("get_appointment_options", READ_ARGS);
        expect(r.status).toBe("POLICY_DENIED");
        expect(r.data ?? null).toBeNull();
      } finally {
        set(false);
      }
    }
    // The caller recites name and date of birth: still A0.
    const spoken = await call.tool("begin_verification", { method: "SECURE_LINK", locator: { kind: "NAME_DOB", fullName: AVERY.fullName, dateOfBirth: AVERY.dateOfBirth } });
    expect(spoken.data ?? {}).not.toHaveProperty("assurance");
    expect(await call.authGate()).toBe(false);
    expect((await call.tool("get_appointment_options", READ_ARGS)).status).toBe("POLICY_DENIED");
    await call.end("CALLER_HANGUP");
  }

  it("[FAILURE:ACT-05][ACT-05] the template store loses the protected template: the response gate refuses to speak it and falls back to the safe explanation without the protected value", async () => {
    const call = await verified();
    const r = await call.tool("get_appointment_options", READ_ARGS);
    expect(r.status).toBe("SUCCESS");
    expect(r.speech?.templateId).toBe("appointment.option_offer");
    expect(call.render(r)).not.toBeNull();
    const templates = h.c.templates;
    const get = templates.get.bind(templates);
    await replaced(templates, "get", ((id: string, locale: string) => (id === "appointment.option_offer" ? undefined : get(id, locale))) as typeof templates.get, async () => {
      const speech = r.speech;
      if (!speech) throw new Error("expected a speech directive");
      const gated = h.c.deps.responseGate.render(speech, {
        sessionRef: call.sessionRef as string,
        currentTurnId: r.speech?.turnId as string,
        sessionGeneration: r.speech?.sessionGeneration as number,
        validAuthorizationRefs: new Set(r.policyDecisionId ? [r.policyDecisionId] : []),
        locale: "en-US",
        environment: h.c.environment,
      });
      expect(gated.ok).toBe(false);
      const text = JSON.stringify(gated);
      for (const slot of Object.values((r.speech?.slots ?? {}) as Record<string, unknown>)) if (typeof slot === "string" && slot.length > 3) expect(text).not.toContain(slot);
    });
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:AUTH-03][AUTH-03] the trusted session store fails or holds a torn record: protected tools fail closed and nothing falls back to caller- or model-supplied identity", async () => {
    const call = await verified();
    const pk = kvKeys.session(sessionRefHash(call.sessionRef as string));
    const kv = h.c.kv;
    const get = kv.get.bind(kv);
    // (a) the store read fails.
    await replaced(kv, "get", (async (key: string) => {
      if (key === pk) throw new Error("injected session store read failure");
      return get(key);
    }) as typeof kv.get, async () => {
      const r = await call.tool("get_appointment_options", READ_ARGS);
      expect(deniedOrFailed.has(r.status), r.status).toBe(true);
      expect(r.data ?? null).toBeNull();
    });
    // (b) a torn record (fails the strict session schema) is never read as a valid identity.
    const item = await get<Record<string, unknown>>(pk);
    expect(item).not.toBeNull();
    await replaced(kv, "get", (async (key: string) => {
      if (key === pk && item) return { ...item, data: { ...item.data, assurance: "A9", actorId: PEOPLE.blake.actorId } };
      return get(key);
    }) as typeof kv.get, async () => {
      const r = await call.tool("get_appointment_options", READ_ARGS);
      expect(r.status).toBe("POLICY_DENIED");
      expect(r.data ?? null).toBeNull();
      expect(await call.authGate()).toBe(false);
    });
    // (c) identity in the arguments is refused by the strict tool schema, before any session lookup.
    const forged = await call.tool("get_appointment_options", { ...READ_ARGS, subjectId: PEOPLE.blake.subjectId, assurance: "A3" });
    expect(forged.status).not.toBe("SUCCESS");
    expect(forged.data ?? null).toBeNull();
    // Store healthy again: the server-established context is Avery's, unchanged by any of the above.
    const ok = await call.tool("get_appointment_options", READ_ARGS);
    expect(ok.status).toBe("SUCCESS");
    expect(JSON.stringify(ok.data)).not.toContain(PEOPLE.blake.subjectId);
    const events = await h.auditFor(call.callId);
    const reads = events.filter((e) => e.action === "tool.invoke" && e.outcome === "SUCCEEDED" && e.evidencePointers.includes("db://tool_catalog/get_appointment_options/1.0.0"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((e) => e.actorRef === AVERY.actorId)).toBe(true);
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:AUTH-05][AUTH-05] the relationship directory fails: a practice user's delegated read fails closed (no record of any practice disclosed) and recovers only when the directory answers", async () => {
    const call = await verified(RILEY, "riley.synthetic", "practice_staff");
    const args = { practiceId: ORGANIZATIONS.practiceNorth.organizationId, fromDate: "2026-09-01", toDate: "2026-10-15" };
    const northIds = REMITTANCES.filter((r) => r.practiceId === ORGANIZATIONS.practiceNorth.organizationId).map((r) => r.remittanceId);
    for (const kind of ["OUTAGE", "TIMEOUT_BEFORE_SEND"] as const) {
      const id = h.c.fixtures.faults.inject({ integrationId: "relationship-directory", operation: "relationshipsFor", kind, mode: "persistent" });
      try {
        const r = await call.tool("get_remittance_status", args);
        expect(deniedOrFailed.has(r.status), `${kind} ${r.status}`).toBe(true);
        expect(r.reasonCode).toBe("RELATIONSHIPS_UNAVAILABLE");
        expect(r.data ?? null).toBeNull();
        for (const rid of northIds) expect(JSON.stringify(r)).not.toContain(rid);
      } finally {
        h.c.fixtures.faults.clear(id);
      }
    }
    const ok = await call.tool("get_remittance_status", args);
    expect(ok.status).toBe("SUCCESS");
    const events = await h.auditFor(call.callId);
    expect(events.filter((e) => e.action === "tool.invoke" && e.reasonCode === "RELATIONSHIPS_UNAVAILABLE").length).toBeGreaterThanOrEqual(2);
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:DATA-01][DATA-01] a dependency error that carries PHI text never reaches the tool result, the logs or the audit trail", async () => {
    const call = await verified();
    const phi = [AVERY.fullName, AVERY.dateOfBirth, AVERY.subjectId];
    const scheduling = h.c.fixtures.scheduling;
    const logFrom = h.logs.length;
    const boom = (async () => {
      throw new Error(`scheduling lookup failed for ${AVERY.fullName} born ${AVERY.dateOfBirth} (${AVERY.subjectId})`);
    }) as never;
    await replaced(scheduling, "listSlots", boom, async () => {
      await replaced(scheduling, "getAppointment", boom, async () => {
        const r = await call.tool("get_appointment_options", READ_ARGS);
        expect(r.status).not.toBe("SUCCESS");
        const visible = JSON.stringify(r);
        for (const f of phi) expect(visible).not.toContain(f);
      });
    });
    const logs = JSON.stringify(h.logs.slice(logFrom));
    for (const f of [AVERY.fullName, AVERY.dateOfBirth]) expect(logs).not.toContain(f);
    const audit = JSON.stringify(await h.auditFor(call.callId));
    for (const f of [AVERY.fullName, AVERY.dateOfBirth]) expect(audit).not.toContain(f);
    expect(audit).not.toContain("scheduling lookup failed");
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:DATA-04][DATA-04] support memory fails or returns a forged recap: no recap establishes identity, consent or authorization", async () => {
    // An unverified caller on Avery's phone; the memory store returns a recap as if the caller were Avery at A2.
    const call = h.call();
    await call.start();
    await call.role("client");
    const memory = h.c.memory;
    const forged = (async () => ({ supportReference: "SR-FORGED-0001", issueCategory: "appointment", subjectId: AVERY.subjectId, assurance: "A2", consent: "GRANTED" })) as never;
    await replaced(memory, "recapFor", forged, async () => {
      const r = await call.tool("get_authorized_case_status", { supportReference: null });
      expect(r.status).toBe("POLICY_DENIED");
      expect(r.data ?? null).toBeNull();
      expect(JSON.stringify(r)).not.toContain("SR-FORGED-0001");
      expect(await call.authGate()).toBe(false);
    });
    // A verified caller while the memory store is down: the tool never fails open into a recap and the session is unchanged.
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    await replaced(memory, "recapFor", (async () => {
      throw new Error("injected memory store outage");
    }) as never, async () => {
      const r = await call.tool("get_authorized_case_status", { supportReference: null });
      expect(r.speech?.templateId ?? null).not.toBe("case.recap_open_issue");
      expect(JSON.stringify(r)).not.toContain("SR-FORGED-0001");
      expect(await call.authGate()).toBe(true);
    });
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:ACT-04][ACT-04] the CRM is down when a support request is created: the call ends REQUEST_ACCEPTED, never RESOLVED, before and after the sync recovers", async () => {
    const call = await verified();
    const id = h.c.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    let ref: string | undefined;
    try {
      const created = await call.tool("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" });
      expect(created.status).toBe("SUCCESS");
      ref = (created.data?.request as { supportReference: string }).supportReference;
      await h.runWorker(undefined, 2);
      const end = await call.end("FLOW_COMPLETED");
      expect(end.outcome).toBe("REQUEST_ACCEPTED");
    } finally {
      h.c.fixtures.faults.clear(id);
    }
    await h.runWorker(undefined, 3);
    const outcomes = await h.q<{ outcome: string }>("select outcome from interaction_outcomes where call_id = $1 order by 1", [call.callId]);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.outcome !== "RESOLVED")).toBe(true);
    expect(ref).toBeDefined();
    const [sr] = await h.q<{ reference_number: string }>("select reference_number from support_requests where reference_number = $1", [ref]);
    expect(sr?.reference_number).toBe(ref);
  }, 120_000);

  it("[FAILURE:SAFE-01][SAFE-01] the clinical route cannot be reached (telephony down): a medication question still gets only the boundary statement, never an answer", async () => {
    const call = h.call();
    await call.start();
    const id = h.c.fixtures.faults.inject({ integrationId: "talkdesk-telephony", operation: "*", kind: "OUTAGE", mode: "persistent" });
    try {
      const r = await call.screen("Should I increase my sertraline dose?");
      expect(r.status).toBe(200);
      expect(r.body.route).toBe("CLINICAL_BOUNDARY_ROUTE");
      const templateId = r.body.speechTemplateId as string;
      const text = h.c.templates.get(templateId, "en-US")?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\b(mg|milligram|dose|dosage|increase|decrease|diagnos|you (?:have|should take))\b/i);
      expect(h.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId)).toHaveLength(0);
      const audit = await h.auditFor(call.callId);
      expect(audit.some((e) => e.action === "safety.clinical_boundary")).toBe(true);
    } finally {
      h.c.fixtures.faults.clear(id);
    }
    await call.end("CALLER_HANGUP");
  }, 120_000);

  it("[FAILURE:SAFE-05][SAFE-05] the standard destination is unavailable: the transfer fails over only to allowlisted destinations; a caller-supplied target is refused", async () => {
    // SAFE-02: the human route needs no verification, so this caller is not verified.
    const call = h.call();
    await call.start();
    h.c.fixtures.telephony.scriptDestination("dst_support_general", { outcome: "RECEIVER_UNAVAILABLE" });
    h.c.fixtures.telephony.scriptDestination("dst_outage_continuity", { outcome: "CONNECTED" });
    const smuggled = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [], destinationId: "+15550100" });
    expect(smuggled.status).not.toBe("SUCCESS");
    const r = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] });
    expect(r.status).toBe("SUCCESS");
    for (let i = 0; i < 6; i++) {
      h.clock.advanceMs(31_000);
      await h.runWorker(["telephony.local_fixture_delivery", "transfers.sweep"]);
    }
    const dials = h.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId);
    expect(dials.length).toBeGreaterThanOrEqual(2);
    expect(dials.every((d) => ALLOWLIST.has(d.destinationId))).toBe(true);
    expect(dials.map((d) => d.destinationId)).toContain("dst_outage_continuity");
    expect(JSON.stringify(dials)).not.toContain("5550100");
    await call.end("TRANSFERRED");
  }, 120_000);
});

describe("[FO-19-05][FO-02-28] failure injection at the startup guard and the release manifest", () => {
  const liveKinds = (): Record<string, "local_fixture" | "live"> => new Proxy({}, { get: () => "live", ownKeys: () => [], getOwnPropertyDescriptor: () => undefined }) as Record<string, "live">;

  it("[FAILURE:OPS-04][OPS-04][FAILURE:OPS-05][OPS-05] the approval trust key cannot be resolved: production (and sandbox) refuse to start; nothing falls back to unverified approvals or fixtures", async () => {
    for (const environment of ["production", "sandbox"] as const) {
      const { logger, records } = createMemoryLogger();
      let err: unknown = null;
      try {
        await loadDeployableConfig({
          environment,
          clock: new FakeClock("2026-10-19T12:00:00.000Z"),
          adapterKinds: environment === "production" ? liveKinds() : {},
          loadedPolicy: { version: "v1", digest: "a".repeat(64) },
          toolCatalogDigest: "b".repeat(64),
          env: {},
          logger,
          keyResolvers: [
            {
              kind: "file",
              resolve: async (): Promise<KeyObject | null> => {
                throw new Error("injected key store outage");
              },
            } as never,
          ],
        });
      } catch (e) {
        err = e;
      }
      expect(err, environment).toBeInstanceOf(ConfigurationRejectedError);
      expect((err as ConfigurationRejectedError).violations.length).toBeGreaterThan(0);
      expect(records.some((r) => r.event === "config.guard.accepted")).toBe(false);
      expect(records.some((r) => r.event === "config.guard.rejected")).toBe(true);
    }
  });

  it("[FAILURE:OPS-06][OPS-06] git and the policy bundle digest are unreadable: the release manifest binds nothing it could not read (placeholders, BLOCKED, unsigned)", () => {
    const res = buildReleaseManifest({
      targetEnvironment: "production",
      root: "/nonexistent-vsp-root",
      git: { head: () => null, dirty: () => null },
      clock: new FakeClock("2026-10-19T12:00:00.000Z"),
      idSource: () => "rel_failureInjection01",
      evidenceDir: "/nonexistent-vsp-root/evidence",
    });
    const codes = res.blockers.map((b) => b.code);
    for (const c of ["SOURCE_COMMIT_UNAVAILABLE", "POLICY_BUNDLE_UNPINNED", "MIGRATIONS_UNREADABLE", "EVALUATION_CORPUS_UNREADABLE"]) expect(codes, c).toContain(c);
    expect(res.manifest.migrationsDigest).toBe(UNPINNED_DIGEST);
    expect(res.manifest.evaluationCorpusDigest).toBe(UNPINNED_DIGEST);
    expect(res.manifest.policyBundleDigest).toBe(UNPINNED_DIGEST);
    expect(res.manifest.status).toBe("BLOCKED");
    expect(res.manifest.signature).toBeNull();
    expect(res.manifest.versions.policyBundle).toBe("UNPINNED");
  });
});
