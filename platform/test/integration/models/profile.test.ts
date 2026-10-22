/**
 * Layer 2, real-model local profile and catalogue discovery commands (WP-08; FO-16-24, FO-09-11, FO-19-09, OPS-05):
 * the production CLIs run as child processes against the `model-emulator` compose service over TLS. A profile with no
 * reviewed credential reports NOT_CONFIGURED, exits 3 and the emulator records ZERO requests for its host; a configured
 * profile runs the synthetic task once; the discovery command writes a dated snapshot (OpenAI listing and the
 * SigV4-signed Bedrock control-plane listing). Synthetic keys only, passed through the child's environment.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { layer2 } from "../_harness/layer2.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { PLATFORM_ROOT } from "../_harness/env.js";
import { EmulatorAdmin, HTTPS_PORT, SERVICE, createModelPki, egressPolicyFor, endpointConfig, hostFor, syntheticAws, syntheticKey } from "./support.js";
import type { TestPki } from "./support.js";
import type { ModelProvider } from "../../../src/models/port/types.js";

const it = layer2(["model-emulator"]);
let pki: TestPki;
let dir: string;
beforeAll(() => {
  pki = createModelPki();
  dir = mkdtempSync(join(tmpdir(), "vsp-models-cli-"));
});
afterAll(() => {
  pki.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
}

function cli(script: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", script, ...args], { cwd: PLATFORM_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, ...env }, timeout: 60_000 }, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout });
    });
  });
}

async function profileFile(l2: Layer2Context, provider: ModelProvider, over: Record<string, unknown> = {}, extraHosts: string[] = []) {
  const host = hostFor(provider);
  const endpoint = endpointConfig(provider, host, { environments: ["local"] });
  const admin = EmulatorAdmin.of(l2);
  for (const h of [host, ...extraHosts]) await admin.tls(h, pki);
  const file = join(dir, `${host}.json`);
  const raw = {
    schemaVersion: "real-model-profile.v1",
    profileId: `rm-${provider.slice(0, 6)}`,
    endpoint,
    credential: { source: "env", variable: "VSP_MODEL_SYNTH_KEY" },
    review: { approvalId: "apr_synthModelReview001", dataControlsRef: "data.controls.synth", reviewedOn: "2026-10-01" },
    localWeights: null,
    billable: null,
    egress: egressPolicyFor([endpoint], extraHosts),
    emulatorRoutes: { routes: [host, ...extraHosts].map((h) => ({ host: h, port: l2.port(SERVICE, HTTPS_PORT) })), caFile: pki.caPath },
    ...over,
  };
  writeFileSync(file, JSON.stringify(raw));
  return { host, file, admin, endpoint };
}

const CLI_REAL = "src/models/adapters/cli-real-model.ts";
const CLI_DISCOVER = "src/models/adapters/cli-discover-catalogue.ts";

describe("real-model local profile and discovery commands [FO-16-24][FO-09-11]", () => {
  it("[FO-16-24][OPS-05] no reviewed credential: status and run report NOT_CONFIGURED, exit 3, and the emulator records zero requests", async ({ l2 }) => {
    const p = await profileFile(l2, "openai_responses", { credential: null, review: null });
    await p.admin.host(p.host, { bearer: [syntheticKey()], models: ["emulated-text"] });
    const status = await cli(CLI_REAL, ["status", "--profile", p.file]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "NOT_CONFIGURED", executable: false, reasons: expect.arrayContaining(["MODEL_CREDENTIAL_NOT_CONFIGURED", "MODEL_CREDENTIAL_NOT_REVIEWED"]) });
    const run = await cli(CLI_REAL, ["run", "--profile", p.file], { VSP_MODEL_SYNTH_KEY: syntheticKey() });
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ ran: false, status: { status: "NOT_CONFIGURED" } });
    const discover = await cli(CLI_DISCOVER, ["--profile", p.file, "--out", join(dir, "none")]);
    expect(discover.code).toBe(3);
    expect(await p.admin.requests(p.host)).toEqual([]);
  });

  it("[FO-16-24][FO-19-09] a reviewed credential runs the synthetic task once through the production port over TLS", async ({ l2 }) => {
    const p = await profileFile(l2, "openai_responses");
    const key = syntheticKey();
    await p.admin.host(p.host, { bearer: [key], models: ["emulated-text"] });
    const run = await cli(CLI_REAL, ["run", "--profile", p.file], { VSP_MODEL_SYNTH_KEY: key });
    expect(run.code, run.stdout).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ran: true, outcome: "COMPLETED", attempts: 1, status: { status: "CONFIGURED", executable: true } });
    const log = await p.admin.requests(p.host);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ authorized: true, store: false, completed: true });
    // The command prints no model text, only its length.
    expect(run.stdout).not.toContain("synthetic emulated reply");
  });

  it("[FO-09-11] discovery writes a dated snapshot: OpenAI listing and the SigV4-signed Bedrock control-plane listing", async ({ l2 }) => {
    const o = await profileFile(l2, "openai_responses");
    const key = syntheticKey();
    await o.admin.host(o.host, { bearer: [key], models: ["emulated-text", "emulated-tools"] });
    const outA = join(dir, "snap-openai");
    const a = await cli(CLI_DISCOVER, ["--profile", o.file, "--out", outA], { VSP_MODEL_SYNTH_KEY: key });
    expect(a.code, a.stdout).toBe(0);
    const [fileA] = readdirSync(outA);
    expect(fileA).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${o.endpoint.endpointRef.replace(/\./g, "\\.")}\\.json$`));
    expect(JSON.parse(readFileSync(join(outA, fileA!), "utf8"))).toMatchObject({ schemaVersion: "model-catalogue-snapshot.v1", provider: "openai_responses", pinnedModelListed: true, models: [{ id: "emulated-text" }, { id: "emulated-tools" }] });

    const cp = hostFor("bedrock_converse").replace(/^t/, "cp");
    const b = await profileFile(l2, "bedrock_converse", { credential: { source: "aws_env" } }, [cp]);
    const aws = syntheticAws();
    await b.admin.host(cp, { aws: [aws], region: "us-east-1", models: ["emulated-text"] });
    const outB = join(dir, "snap-bedrock");
    const r = await cli(CLI_DISCOVER, ["--profile", b.file, "--out", outB, "--control-plane-url", `https://${cp}/foundation-models?byOutputModality=TEXT`], { AWS_ACCESS_KEY_ID: aws.accessKeyId, AWS_SECRET_ACCESS_KEY: aws.secretAccessKey });
    expect(r.code, r.stdout).toBe(0);
    const [fileB] = readdirSync(outB);
    expect(JSON.parse(readFileSync(join(outB, fileB!), "utf8"))).toMatchObject({ provider: "bedrock_converse", source: "GET /foundation-models", models: [{ id: "emulated-text", lifecycle: "ACTIVE" }] });
    expect((await b.admin.requests(cp))[0]).toMatchObject({ api: "bedrock_control", sigv4: "VERIFIED" });
  });
});
