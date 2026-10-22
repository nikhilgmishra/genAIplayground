/**
 * Real-model local profile (WP-08; FO-16-24, FO-19-09, OPS-05, DATA-01). Evaluation never opens a socket; a profile
 * without a reviewed credential (or licensed local weights) is NOT_CONFIGURED and makes ZERO outbound requests, which
 * is asserted at the socket and DNS level (spies on node:net connect and node:dns lookup) as well as at the exchange.
 * Runs that do execute go to the in-process protocol emulator; no real provider is contacted.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import { EgressGuard } from "../../privacy/egress.js";
import { systemClock } from "../../shared/clock.js";
import { egressBindingFor } from "../port/config.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { endpointConfig, egressPolicyFor, hostFor, syntheticKey, testMetrics } from "../../../test/emulators/models/harness.js";
import { TransportModelExchange } from "./http-exchange.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { RealModelProfile, evaluateRealModelProfile, processEnv, realModelDestination, runRealModelProfile } from "./real-model-profile.js";
import type { RealModelProfileEnv } from "./real-model-profile.js";

let emulator: ModelEmulator;
let dir: string;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
  dir = mkdtempSync(join(tmpdir(), "vsp-real-model-"));
});
afterAll(async () => {
  await emulator.stop();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Test environment: variables from the test, credential files read by the PRODUCTION reader (processEnv). */
const env = (vars: Record<string, string> = {}): RealModelProfileEnv => ({
  getEnv: (n) => vars[n],
  readSecretFile: (p) => processEnv.readSecretFile(p),
});

function profile(provider: "openai_responses" | "bedrock_converse" | "vllm_openai_compatible", over: Record<string, unknown> = {}, endpointOver: Record<string, unknown> = {}) {
  const host = hostFor(provider);
  const endpoint = endpointConfig(provider, host, { environments: ["local"], ...endpointOver });
  return {
    host,
    endpoint,
    raw: {
      schemaVersion: "real-model-profile.v1",
      profileId: `rm-${provider.slice(0, 6)}`,
      endpoint,
      credential: { source: "env", variable: "VSP_MODEL_SYNTH_KEY" },
      review: { approvalId: "apr_synthModelReview001", dataControlsRef: "data.controls.synth", reviewedOn: "2026-10-01" },
      localWeights: null,
      billable: null,
      egress: egressPolicyFor([endpoint]),
      // The emulator label must be backed by a loopback route for the endpoint host (the tests inject the exchange).
      emulatorRoutes: endpoint.adapterKind === "emulator" ? { routes: [{ host, port: emulator.httpPort }], caFile: "/unused/emulator-ca.pem" } : null,
      ...over,
    },
  };
}

/**
 * Counts every outbound TCP/TLS socket and DNS lookup of the process while `fn` runs. The DNS spy goes on the
 * built-in's CommonJS object and is synced into the ESM bindings the transport imports (syncBuiltinESMExports).
 */
async function countNetwork<T>(fn: () => Promise<T>): Promise<{ value: T; sockets: number; lookups: number }> {
  const cjsDns = createRequire(import.meta.url)("node:dns") as { lookup: (...args: unknown[]) => unknown };
  const connect = vi.spyOn(net.Socket.prototype, "connect");
  const lookup = vi.spyOn(cjsDns, "lookup");
  syncBuiltinESMExports();
  try {
    const value = await fn();
    return { value, sockets: connect.mock.calls.length, lookups: lookup.mock.calls.length };
  } finally {
    connect.mockRestore();
    lookup.mockRestore();
    syncBuiltinESMExports();
  }
}

/** An exchange over the production transport to the in-process emulator (plain loopback route), counting sends. */
function emulatorExchange(p: ReturnType<typeof profile>): ModelHttpExchange & { sends: number } {
  const guard = new EgressGuard(p.raw.egress, { environment: "local" });
  const transport = new ConnectorHttpTransport({ environment: "local", egress: guard.forModelEndpoint(egressBindingFor(p.endpoint)), loopbackRoutes: new Map([[p.host, { port: emulator.httpPort, tls: false }]]) });
  const inner = new TransportModelExchange(transport, { allowedHosts: [p.host], addressClass: "PUBLIC_INTERNET" });
  const counted = { incremental: inner.incremental, sends: 0, send: async (req: Parameters<ModelHttpExchange["send"]>[0]) => {
    counted.sends += 1;
    return inner.send(req);
  } };
  return counted;
}

describe("real-model local profile [FO-16-24][OPS-05]", () => {
  it("[FO-16-24][OPS-05] no credential configured: NOT_CONFIGURED and zero outbound requests (no socket, no DNS lookup, no exchange)", async () => {
    const p = profile("openai_responses", { credential: null, review: null });
    const exchange = emulatorExchange(p);
    const metrics = testMetrics();
    const { value, sockets, lookups } = await countNetwork(() => runRealModelProfile(p.raw, { clock: systemClock, env: env(), exchange, metrics }));
    expect(value.result).toBeNull();
    expect(value.status).toMatchObject({ status: "NOT_CONFIGURED", executable: false, reasons: expect.arrayContaining(["MODEL_CREDENTIAL_NOT_CONFIGURED", "MODEL_CREDENTIAL_NOT_REVIEWED"]) });
    expect({ sockets, lookups, sends: exchange.sends }).toEqual({ sockets: 0, lookups: 0, sends: 0 });
    expect(emulator.requests(p.host)).toEqual([]);
    expect(metrics.gaugeValue("vsp_model_profile_status", { provider: "openai_responses", status: "NOT_CONFIGURED" })).toBe(1);
  });

  it("[FO-16-24] a credential source without a value, without a review, or in a file others can read leaves the profile NOT_CONFIGURED", () => {
    expect(evaluateRealModelProfile(profile("openai_responses").raw, env()).reasons).toEqual(["MODEL_CREDENTIAL_UNAVAILABLE"]);
    expect(evaluateRealModelProfile(profile("openai_responses", { review: null }).raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).reasons).toEqual(["MODEL_CREDENTIAL_NOT_REVIEWED"]);
    const loose = join(dir, "loose.key");
    writeFileSync(loose, syntheticKey());
    chmodSync(loose, 0o644);
    expect(evaluateRealModelProfile(profile("openai_responses", { credential: { source: "file", path: loose } }).raw, env()).reasons).toEqual(["MODEL_CREDENTIAL_FILE_INSECURE"]);
    const tight = join(dir, "tight.key");
    writeFileSync(tight, syntheticKey());
    chmodSync(tight, 0o600);
    expect(evaluateRealModelProfile(profile("openai_responses", { credential: { source: "file", path: tight } }).raw, env()).status).toBe("CONFIGURED");
    expect(evaluateRealModelProfile(profile("bedrock_converse", { credential: { source: "aws_env" } }).raw, env({ AWS_ACCESS_KEY_ID: "akid_synthEnv" })).reasons).toEqual(["MODEL_CREDENTIAL_UNAVAILABLE"]);
  });

  it("[FO-16-24][OPS-05] the production credential-file reader (processEnv.readSecretFile) refuses group- or world-readable files and non-files", () => {
    const key = syntheticKey();
    const write = (name: string, mode: number) => {
      const path = join(dir, name);
      writeFileSync(path, `  ${key}\n`);
      chmodSync(path, mode);
      return path;
    };
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) expect(() => processEnv.readSecretFile(write(`mode-${mode.toString(8)}.key`, mode))).toThrow("MODEL_CREDENTIAL_FILE_INSECURE");
    expect(processEnv.readSecretFile(write("owner-only.key", 0o600))).toBe(key);
    expect(processEnv.readSecretFile(write("owner-read.key", 0o400))).toBe(key);
    const sub = join(dir, "a-directory.key");
    mkdirSync(sub, { mode: 0o700 });
    expect(() => processEnv.readSecretFile(sub)).toThrow("MODEL_CREDENTIAL_FILE_INSECURE");
    expect(() => processEnv.readSecretFile(join(dir, "missing.key"))).toThrow();
    // A symlink to an owner-only file is refused, never followed (security review r4: no symlink, no check/read gap).
    const target = write("link-target.key", 0o600);
    const link = join(dir, "link.key");
    symlinkSync(target, link);
    expect(() => processEnv.readSecretFile(link)).toThrow("MODEL_CREDENTIAL_FILE_INSECURE");
    // A FIFO at the path is refused at once (the open never blocks waiting for a writer).
    const fifo = join(dir, "fifo.key");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(() => processEnv.readSecretFile(fifo)).toThrow("MODEL_CREDENTIAL_FILE_INSECURE");
    // A file owned by another user is refused even with owner-only bits (only root can hand a file to another uid,
    // so this case runs where the suite runs as root, as in the local container).
    if (process.getuid?.() === 0) {
      const foreign = write("foreign-owner.key", 0o600);
      chownSync(foreign, 65534, 65534);
      expect(() => processEnv.readSecretFile(foreign)).toThrow("MODEL_CREDENTIAL_FILE_INSECURE");
    }
    // Evaluated with the production environment itself (a file source reads no environment variable).
    const loose = write("prod-loose.key", 0o644);
    expect(evaluateRealModelProfile(profile("openai_responses", { credential: { source: "file", path: loose } }).raw, processEnv)).toMatchObject({ status: "NOT_CONFIGURED", reasons: ["MODEL_CREDENTIAL_FILE_INSECURE"], credential: null });
    const tight = write("prod-tight.key", 0o600);
    expect(evaluateRealModelProfile(profile("openai_responses", { credential: { source: "file", path: tight } }).raw, processEnv)).toMatchObject({ status: "CONFIGURED", reasons: [] });
    expect(evaluateRealModelProfile(profile("openai_responses", { credential: { source: "file", path: join(dir, "missing.key") } }).raw, processEnv).reasons).toEqual(["MODEL_CREDENTIAL_UNAVAILABLE"]);
  });

  it("[OPS-05] adversarial: emulator routes on a live endpoint are a profile error (REAL_MODEL_EMULATOR_ROUTES_ON_LIVE_ENDPOINT), and nothing is sent", async () => {
    const p = profile("openai_responses", {}, { adapterKind: "live", credentialRef: "local-fixture:models/synth" });
    const raw = { ...p.raw, billable: { approvalId: "apr_synthBillable0001" }, emulatorRoutes: { routes: [{ host: p.host, port: emulator.httpPort }], caFile: "/unused/emulator-ca.pem" } };
    const evaluated = evaluateRealModelProfile(raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }));
    expect(evaluated).toMatchObject({ status: "NOT_CONFIGURED", executable: false, violations: ["REAL_MODEL_EMULATOR_ROUTES_ON_LIVE_ENDPOINT"], credential: null });
    // Control: the same live profile without routes is CONFIGURED and executable (billable approval present).
    expect(evaluateRealModelProfile({ ...raw, emulatorRoutes: null }, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }))).toMatchObject({ status: "CONFIGURED", executable: true, violations: [] });
    const exchange = emulatorExchange(p);
    const { value, sockets, lookups } = await countNetwork(() => runRealModelProfile(raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }), exchange }));
    expect(value.result).toBeNull();
    expect({ sockets, lookups, sends: exchange.sends }).toEqual({ sockets: 0, lookups: 0, sends: 0 });
  });

  it("[OPS-05] adversarial: a reviewed key on a PAID live provider without the billable approval is CONFIGURED but not executable, and sends nothing", async () => {
    const p = profile("openai_responses", {}, { adapterKind: "live", credentialRef: "local-fixture:models/synth" });
    const exchange = emulatorExchange(p);
    const { value, sockets } = await countNetwork(() => runRealModelProfile(p.raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }), exchange }));
    expect(value).toMatchObject({ result: null, status: { status: "CONFIGURED", executable: false, reasons: ["BILLABLE_EXECUTION_NOT_APPROVED"] } });
    expect({ sockets, sends: exchange.sends }).toEqual({ sockets: 0, sends: 0 });
  });

  it("[DATA-01] adversarial: a local profile that would carry PHI, or run outside local, is refused as a profile error", () => {
    const phi = profile("openai_responses", {}, { maxDataClass: "PHI" });
    expect(evaluateRealModelProfile(phi.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).violations).toContain("REAL_MODEL_PROFILE_SYNTHETIC_ONLY");
    const ci = profile("openai_responses", {}, { environments: ["ci"] });
    expect(evaluateRealModelProfile(ci.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).violations).toContain("REAL_MODEL_PROFILE_LOCAL_ONLY");
    expect(evaluateRealModelProfile({ schemaVersion: "real-model-profile.v1" }, env()).violations).toEqual(["REAL_MODEL_PROFILE_INVALID"]);
  });

  it("[FO-16-24][FO-19-09] a reviewed credential runs the synthetic text task through the production port (emulator endpoint)", async () => {
    const p = profile("openai_responses");
    const key = syntheticKey();
    emulator.registerHost(p.host, { bearer: [key], models: ["emulated-text"] });
    const exchange = emulatorExchange(p);
    const { value: run, sockets } = await countNetwork(() => runRealModelProfile(p.raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: key }), exchange }));
    // Positive control of the socket spy used above: a run that does send is seen at the socket level.
    expect(sockets).toBeGreaterThanOrEqual(1);
    expect(run.status).toMatchObject({ status: "CONFIGURED", executable: true, reasons: [] });
    expect(run.result).toMatchObject({ outcome: "COMPLETED", provider: "openai_responses" });
    expect(exchange.sends).toBe(1);
    expect(emulator.requests(p.host)[0]).toMatchObject({ authorized: true, store: false });
  });

  it("[FO-16-24] licensed local weights on a private vLLM server run without a key and without a billable approval", async () => {
    const p = profile("vllm_openai_compatible", { credential: { source: "none" }, review: null, localWeights: { manifestSha256: "a".repeat(64), licenceReviewRef: "licence.weights.synth" } }, { network: "PRIVATE_NETWORK", adapterKind: "live", credentialRef: null });
    expect(realModelDestination(RealModelProfile.parse(p.raw))).toBe("SELF_HOSTED_PRIVATE");
    emulator.registerHost(p.host, { bearer: "none", models: ["emulated-text"] });
    const unlicensed = evaluateRealModelProfile({ ...p.raw, localWeights: null }, env());
    expect(unlicensed.reasons).toEqual(expect.arrayContaining(["MODEL_CREDENTIAL_NOT_REVIEWED", "MODEL_WEIGHTS_NOT_LICENSED"]));
    const run = await runRealModelProfile(p.raw, { clock: systemClock, env: env(), exchange: emulatorExchange(p) });
    expect(run.status).toMatchObject({ status: "CONFIGURED", executable: true });
    expect(run.result?.outcome).toBe("COMPLETED");
  });

  it("[DATA-01] failure injection: without an egress entry for the endpoint's terms the profile is NOT_CONFIGURED and sends nothing", async () => {
    const p = profile("openai_responses", { egress: { policyVersion: "empty.1", destinations: [] } });
    const exchange = emulatorExchange(profile("openai_responses"));
    const run = await runRealModelProfile(p.raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }), exchange });
    expect(run).toMatchObject({ result: null, status: { status: "NOT_CONFIGURED", reasons: ["EGRESS_DESTINATION_UNKNOWN"] } });
    expect(exchange.sends).toBe(0);
  });

  it("[OPS-05] adversarial (s07 a): an emulator label on a paid provider host without a loopback route is a profile error; running it opens no socket and makes no DNS lookup", async () => {
    const p = profile("openai_responses", { emulatorRoutes: null }, { baseUrl: "https://api.paid-provider.models.test" });
    const evaluated = evaluateRealModelProfile(p.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }));
    expect(evaluated).toMatchObject({ status: "NOT_CONFIGURED", executable: false, violations: expect.arrayContaining(["REAL_MODEL_EMULATOR_ROUTES_MISSING"]) });
    // No injected exchange: the default (production) exchange would resolve the host; nothing may be opened.
    const { value, sockets, lookups } = await countNetwork(() => runRealModelProfile(p.raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }) }));
    expect(value.result).toBeNull();
    expect({ sockets, lookups }).toEqual({ sockets: 0, lookups: 0 });
    // A route that covers ANOTHER host does not make the endpoint host local either.
    const other = profile("openai_responses", { emulatorRoutes: { routes: [{ host: "elsewhere.models.test", port: emulator.httpPort }], caFile: "/unused/emulator-ca.pem" } });
    expect(evaluateRealModelProfile(other.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).violations).toContain("REAL_MODEL_EMULATOR_ROUTES_MISSING");
  });

  it("[OPS-05] adversarial (s07 b/c): a vLLM label with a local-weights record on a public network is HOSTED: review and billable approval required, nothing sent", async () => {
    const weights = { credential: { source: "env", variable: "VSP_MODEL_SYNTH_KEY" }, review: null, localWeights: { manifestSha256: "b".repeat(64), licenceReviewRef: "licence.weights.synth" } };
    const pub = profile("vllm_openai_compatible", weights, { adapterKind: "live", network: "PUBLIC_INTERNET", credentialRef: null, environments: ["local"] });
    expect(realModelDestination(RealModelProfile.parse(pub.raw))).toBe("HOSTED");
    expect(evaluateRealModelProfile(pub.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }))).toMatchObject({ status: "NOT_CONFIGURED", executable: false, reasons: expect.arrayContaining(["MODEL_LOCAL_WEIGHTS_NOT_PRIVATE", "MODEL_CREDENTIAL_NOT_REVIEWED"]) });
    const review = { approvalId: "apr_synthModelReview001", dataControlsRef: "data.controls.synth", reviewedOn: "2026-10-01" };
    // A local-weights record on a hosted destination stays inconsistent even with a review.
    expect(evaluateRealModelProfile(profile("vllm_openai_compatible", { ...weights, review }, { adapterKind: "live", network: "PUBLIC_INTERNET", credentialRef: null }).raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).reasons).toEqual(["MODEL_LOCAL_WEIGHTS_NOT_PRIVATE"]);
    // Reviewed, no weights claim, still a hosted (paid) destination: not executable without the billable approval, and nothing is sent.
    const reviewed = profile("vllm_openai_compatible", { ...weights, localWeights: null, review }, { adapterKind: "live", network: "PUBLIC_INTERNET", credentialRef: null });
    const exchange = emulatorExchange(reviewed);
    const { value, sockets } = await countNetwork(() => runRealModelProfile(reviewed.raw, { clock: systemClock, env: env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }), exchange }));
    expect(value).toMatchObject({ result: null, status: { status: "CONFIGURED", executable: false, reasons: ["BILLABLE_EXECUTION_NOT_APPROVED"] } });
    expect({ sockets, sends: exchange.sends }).toEqual({ sockets: 0, sends: 0 });
    // PRIVATE_NETWORK but a model-provider (not self-hosted) destination: still HOSTED.
    const mislabelled = profile("vllm_openai_compatible", weights, { adapterKind: "live", network: "PRIVATE_NETWORK", credentialRef: null });
    const raw = { ...mislabelled.raw, egress: { ...mislabelled.raw.egress, destinations: mislabelled.raw.egress.destinations.map((d) => ({ ...d, kind: "MODEL_PROVIDER_API" as const })) } };
    expect(realModelDestination(RealModelProfile.parse(raw))).toBe("HOSTED");
    expect(evaluateRealModelProfile(raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() })).executable).toBe(false);
  });

  it("[OPS-05] the billable gate is the destination's: an OpenAI or Bedrock profile with an emulator route needs no billable approval, a hosted one needs it", () => {
    const routed = profile("openai_responses");
    expect(realModelDestination(RealModelProfile.parse(routed.raw))).toBe("EMULATOR");
    expect(evaluateRealModelProfile(routed.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }))).toMatchObject({ status: "CONFIGURED", executable: true });
    const hosted = profile("openai_responses", { billable: { approvalId: "apr_synthBillable0001" } }, { adapterKind: "live", credentialRef: "local-fixture:models/synth" });
    expect(evaluateRealModelProfile(hosted.raw, env({ VSP_MODEL_SYNTH_KEY: syntheticKey() }))).toMatchObject({ status: "CONFIGURED", executable: true, reasons: [] });
  });
});
