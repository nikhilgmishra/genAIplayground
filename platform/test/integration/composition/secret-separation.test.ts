/**
 * Layer 2 (WP-07; AUTH-02, DATA-01, OPS-04, FO-14-56 / FT-91): every secret of the live composition serves one
 * purpose, compared by identity, on the real protocol. The sandbox composes buildLiveContainer over LocalStack
 * Secrets Manager with a REAL connector profile directory (`connectors.profileDirectory`, the files the worker's
 * connector runtime loads, as in faults.test.ts).
 *
 * Covered:
 *   - connector PROFILE credentials are secrets of this environment: the console session sealer equal to a
 *     profile's read credential (gateway, worker and console each refuse: the worker holds the connector
 *     credentials, so it would hold the sealer), and the request-hash pepper equal to a profile's WRITE credential
 *     (the internet-facing gateway reads the pepper, so it would hold a vendor write credential), each refuse the
 *     environment with SECRET_REUSED_ACROSS_PURPOSES at the profile position
 *     (`connectors.credentials.sandbox.profile:<id>:<capability>:<access>`), never a value;
 *   - connector credentials compare by IDENTITY, not by spelling: LocalStack resolves a full and a partial Secrets
 *     Manager ARN to one secret, and that secret named both ways in two adapters, in a profile and an adapter, or in
 *     this and another committed environment's adapters refuses the environment (CREDENTIAL_REUSED_ACROSS_*);
 *   - controls: separate secrets boot; the same-spelling cases are refused as before.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { ConfigurationRejectedError } from "../../../src/shared/errors.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { PROFILE_ID, emulatorProfile } from "../connectors/profiles.js";
import { createSecret } from "../connectors/support.js";
import { SUBSTRATE, TENANT, bootLive, provisionSandbox } from "./support.js";
import type { BootOptions, Sandbox, SandboxConfig } from "./support.js";

const it = layer2([...SUBSTRATE]);
const AT = `connectors.credentials.sandbox.profile:${PROFILE_ID}`;
/** The six-character suffix Secrets Manager appends in a full ARN, removed: the partial ARN of the same secret. */
const partialOf = (arn: string) => arn.replace(/-[A-Za-z0-9]{6}$/, "");
const SEPARATION = /^(SECRET_REUSED_|CREDENTIAL_REUSED_)/;

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

/** Two LocalStack secrets for the profile's read and write credentials (SYNTHETIC client credentials). */
async function profileSecrets(): Promise<{ read: string; write: string }> {
  const read = await createSecret(sb.sm, "comp-sep-read", { clientId: "client-read", clientSecret: "conn_synthSeparationRead01" });
  const write = await createSecret(sb.sm, "comp-sep-write", { clientId: "client-write", clientSecret: "conn_synthSeparationWrite01" });
  return { read, write };
}

/** Writes the connector profile directory (the emulated vendor profile with the given credentials). */
function writeProfile(readRef: string, writeRef: string): void {
  const profile = emulatorProfile({ readRef, writeRef, mutate: (p) => ({ ...p, tenantId: TENANT }) });
  mkdirSync(join(sb.repoRoot, "connectors"), { recursive: true });
  writeFileSync(join(sb.repoRoot, "connectors", "vendor-emulated.json"), JSON.stringify(profile, null, 2));
}

/** A sandbox adapter entry holding a credential reference (the adapter itself stays a local fixture). */
const adapter = (credentialRef: string) => ({ kind: "local_fixture", endpoint: null, credentialRef, authMethod: "oauth2_client_credentials", exceptionApprovalId: null, timeoutMs: 2500 });

/** Boots with the mutated configuration; returns the separation violations of a refusal ([] when it booted). */
async function attempt(mutate: (cfg: SandboxConfig) => void, o: BootOptions = {}): Promise<{ booted: boolean; separation: string[]; all: string[] }> {
  const cfg = sb.config();
  mutate(cfg);
  sb.writeConfig(cfg);
  try {
    const { c } = await bootLive(sb, o);
    await c.close();
    return { booted: true, separation: [], all: [] };
  } catch (err) {
    if (!(err instanceof ConfigurationRejectedError)) throw err;
    return { booted: false, separation: err.violations.filter((v) => SEPARATION.test(v)), all: err.violations };
  } finally {
    sb.writeConfig(sb.config());
  }
}

const withProfiles = (cfg: SandboxConfig) => {
  (cfg as Record<string, unknown>).connectors = { profileDirectory: "connectors", feeds: [] };
};

describe("connector profile credentials are secrets of this environment [AUTH-02][FT-91]", () => {
  it("[AUTH-02][DATA-01] adversarial: the console session sealer equal to a connector profile's read credential refuses the gateway, the worker and the console (SECRET_REUSED_ACROSS_PURPOSES at the profile position)", async () => {
    const { read, write } = await profileSecrets();
    writeProfile(read, write);
    try {
      // Control: the profile with its own credentials boots every unit.
      for (const unit of ["gateway", "worker", "console"] as const) expect((await attempt(withProfiles, { unit })).booted, unit).toBe(true);
      for (const unit of ["gateway", "worker", "console"] as const) {
        const r = await attempt(
          (cfg) => {
            withProfiles(cfg);
            cfg.infrastructure.secrets.consoleSessionSealerRef = read;
          },
          { unit },
        );
        expect(r.booted, unit).toBe(false);
        // The profile's default credential and its READ capability credential are both that secret.
        expect(r.separation, unit).toEqual([`SECRET_REUSED_ACROSS_PURPOSES@${AT}:default:READ`, `SECRET_REUSED_ACROSS_PURPOSES@${AT}:scheduling.appointments_read:READ`]);
        expect(r.all.join(" "), unit).not.toMatch(/arn:aws|conn_synth/);
      }
    } finally {
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
    }
  });

  it("[AUTH-02][DATA-01] adversarial: the request-hash pepper equal to a connector profile's WRITE credential (also by its partial ARN) refuses the environment", async () => {
    const { read, write } = await profileSecrets();
    writeProfile(read, write);
    try {
      for (const pepper of [write, partialOf(write)]) {
        const r = await attempt((cfg) => {
          withProfiles(cfg);
          cfg.infrastructure.secrets.requestHashPepperRef = pepper;
        });
        expect(r.separation, pepper === write ? "full ARN" : "partial ARN").toEqual([`SECRET_REUSED_ACROSS_PURPOSES@${AT}:scheduling.appointments_write:WRITE`]);
      }
    } finally {
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
    }
  });
});

describe("connector credentials compare by identity, not by spelling [AUTH-02][FT-91]", () => {
  it("[AUTH-02] fidelity: LocalStack Secrets Manager resolves the full and the partial ARN of a secret to the same secret", async () => {
    const { read } = await profileSecrets();
    expect(partialOf(read)).not.toBe(read);
    const full = await sb.sm.send(new GetSecretValueCommand({ SecretId: read }));
    const partial = await sb.sm.send(new GetSecretValueCommand({ SecretId: partialOf(read) }));
    expect(partial.ARN).toBe(full.ARN);
    expect(partial.SecretString).toBe(full.SecretString);
  });

  it("[AUTH-02] adversarial: one secret named by its full ARN in one adapter and by its partial ARN in another refuses the environment (CREDENTIAL_REUSED_ACROSS_CONNECTORS); separate secrets boot", async () => {
    const { read, write } = await profileSecrets();
    const control = await attempt((cfg) => {
      cfg.adapters = { billing: adapter(read), claims: adapter(write) };
    });
    expect(control.booted).toBe(true);
    for (const [billing, claims] of [
      [read, read],
      [read, partialOf(read)],
      [partialOf(read), read],
    ] as const) {
      const r = await attempt((cfg) => {
        cfg.adapters = { billing: adapter(billing), claims: adapter(claims) };
      });
      expect(r.separation).toEqual(["CREDENTIAL_REUSED_ACROSS_CONNECTORS@connectors.credentials.sandbox.adapter:claims"]);
      expect(r.all.join(" ")).not.toMatch(/arn:aws/);
    }
  });

  it("[AUTH-02] adversarial: a connector profile credential (full ARN) and an adapter credential (partial ARN of the same secret) refuse the environment once, by the connector rule", async () => {
    const { read, write } = await profileSecrets();
    writeProfile(read, write);
    try {
      const r = await attempt(
        (cfg) => {
          withProfiles(cfg);
          cfg.adapters = { billing: adapter(partialOf(read)) };
        },
        { unit: "worker" },
      );
      expect(r.separation).toEqual(["CREDENTIAL_REUSED_ACROSS_CONNECTORS@connectors.credentials.sandbox.adapter:billing"]);
    } finally {
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
    }
  });

  it("[AUTH-02] adversarial: this environment's adapter or profile credential and a committed other environment's adapter credential naming the same secret by another spelling refuse the environment (CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS)", async () => {
    const { read, write } = await profileSecrets();
    const other = join(sb.configDir, "staging.json");
    try {
      // This environment's adapter by full ARN, staging's adapter by partial ARN.
      writeFileSync(other, JSON.stringify({ environment: "staging", adapters: { billing: { credentialRef: partialOf(read) } } }));
      const a = await attempt((cfg) => {
        cfg.adapters = { billing: adapter(read) };
      });
      expect(a.separation).toEqual(["CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS@connectors.credentials.staging.adapter:billing"]);
      // This environment's profile WRITE credential by partial ARN, staging's adapter by full ARN.
      writeProfile(read, partialOf(write));
      writeFileSync(other, JSON.stringify({ environment: "staging", adapters: { claims: { credentialRef: write } } }));
      const b = await attempt(withProfiles, { unit: "worker" });
      expect(b.separation).toEqual(["CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS@connectors.credentials.staging.adapter:claims"]);
      // Control: staging's own secret.
      writeFileSync(other, JSON.stringify({ environment: "staging", adapters: { claims: { credentialRef: (await profileSecrets()).write } } }));
      expect((await attempt(withProfiles, { unit: "worker" })).booted).toBe(true);
    } finally {
      rmSync(other, { force: true });
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
    }
  });
});
