/**
 * Layer 2 (WP-07; FO-14-53, FO-03-49, AUTH-02, OPS-04): no development bypass reaches the live composition.
 *
 * In the sandbox profile, over the emulators: the LOCAL FIXTURE integration tokens are refused on every tool
 * transport; the local development signing key and `local-fixture:` / `file:` references are refused by the
 * guard; AWS endpoint overrides are accepted only in sandbox and only for emulator host names (staging refuses
 * every override, path-style S3 and the sandbox-only network resolver); assertions are signed by the KMS key
 * (LocalStack Sign/GetPublicKey), never by a development key, and a disabled key fails closed. The console's
 * local sign-in is covered by console.test.ts (it is not even registered in the live console).
 *
 * Guard first (OPS-04, D4 of the WP-07 verifier): an override that names a non-emulator host receives ZERO
 * requests (the client factory refuses it before any client exists, although the approval trust key is resolved
 * over KMS before the guard runs); the control proves the listener would have seen the signed GetPublicKey.
 * Credential separation (AUTH-02, D2): a connector profile whose credential reference is also an adapter's, or
 * another committed environment's, refuses the environment.
 *
 * Test plumbing, labelled: RecordingListener, a plain HTTP listener that answers 500 and records the method,
 * the X-Amz-Target header and whether an Authorization header carried a credential (never its value).
 */
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { buildBusiness } from "../../../src/business/index.js";
import { LOCAL_FIXTURE_TOKENS } from "../../../src/gateway/auth.js";
import { MCP_PATH } from "../../../src/gateway/mcp.js";
import { buildLiveContainer } from "../../../src/main/live-container.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { emulatorProfile } from "../connectors/profiles.js";
import { SUBSTRATE, TENANT, bootLive, createKmsKey, createSecretValue, privateInterfaceAddress, privateResolver, provisionSandbox, refusal } from "./support.js";
import type { Sandbox } from "./support.js";

const it = layer2([...SUBSTRATE]);

/** Test plumbing: an HTTP listener that records what reached it (never header values) and answers 500. */
class RecordingListener {
  readonly received: { method: string; target: string | null; authorizationHasCredential: boolean }[] = [];
  private server: Server | null = null;
  constructor(private readonly host: string) {}
  async start(): Promise<string> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const auth = req.headers.authorization ?? "";
      this.received.push({ method: req.method ?? "", target: typeof req.headers["x-amz-target"] === "string" ? req.headers["x-amz-target"] : null, authorizationHasCredential: /Credential=/.test(auth) });
      req.resume();
      res.writeHead(500, { "content-type": "application/x-amz-json-1.1" }).end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.host, () => resolve());
    });
    this.server = server;
    return `http://${this.host}:${(server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

describe("no development bypass in the live composition [FO-14-53]", () => {
  it("[FO-14-53][AUTH-02] adversarial: every LOCAL FIXTURE integration token is refused (401) on the catalogue, the tool route and MCP", async () => {
    const { c } = await bootLive(sb);
    try {
      expect([c.authenticator.kind, c.deps.localFixture]).toEqual(["live", false]);
      for (const [channel, token] of Object.entries(LOCAL_FIXTURE_TOKENS)) {
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const catalog = await c.app.inject({ method: "GET", url: "/v1/tools/catalog", headers });
        expect(catalog.statusCode, `${channel} catalogue`).toBe(401);
        const tool = await c.app.inject({ method: "POST", url: "/v1/tools/request_human_transfer/1.0.0", headers, payload: { arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } } });
        expect(tool.statusCode, `${channel} tool`).toBe(401);
        const mcp = await c.app.inject({ method: "POST", url: MCP_PATH, headers: { ...headers, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
        expect(mcp.statusCode, `${channel} mcp`).toBe(401);
        expect(`${catalog.body}${tool.body}${mcp.body}`).not.toMatch(/tools\/list|commit_appointment_change/);
      }
    } finally {
      await c.close();
    }
  });

  it("[FO-14-53][OPS-04] adversarial: the development signing key and local key references are refused by the guard in the sandbox profile", async () => {
    const cfg = sb.config();
    (cfg as Record<string, unknown>).signing = { assertionKeyRef: "local-fixture:assertion-dev-key", localDevKey: true };
    (cfg as Record<string, unknown>).database = { engine: "pg", connectionRef: "local-fixture:database" };
    cfg.infrastructure.secrets.requestHashPepperRef = "file:pepper.bin";
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining([
          "SIGNING_LOCAL_DEV_KEY@signing.localDevKey",
          "SIGNING_KEY_REF_LOCAL@signing.assertionKeyRef",
          "DATABASE_CONNECTION_REF_LOCAL@database.connectionRef",
          "REQUEST_HASH_PEPPER_REF_LOCAL@infrastructure.secrets.requestHashPepperRef",
        ]),
      );
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-53] adversarial: endpoint overrides only name emulator hosts in sandbox; staging refuses every override, path-style S3 and the network resolver", async () => {
    const cfg = sb.config();
    const aws = (cfg.infrastructure as unknown as { aws: { endpointOverrides: Record<string, string | null> } }).aws;
    aws.endpointOverrides.kms = "https://kms.us-east-1.amazonaws.com.attacker.example.com";
    sb.writeConfig(cfg);
    try {
      expect(await refusal(bootLive(sb))).toContain("INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.kms");
    } finally {
      sb.writeConfig(sb.config());
    }
    // The same (emulator) overrides in a staging configuration: refused before any client is built. The staging
    // file is a copy of the sandbox one, so it is removed afterwards: left in the configuration directory it is a
    // committed environment sharing the sandbox's keys and secrets, which the key separation rule refuses.
    const staging = { ...sb.config(), environment: "staging" };
    const stagingFile = join(sb.configDir, "staging.json");
    writeFileSync(stagingFile, JSON.stringify(staging, null, 2));
    try {
      const boot = (network?: Parameters<typeof buildLiveContainer>[0]["network"]) =>
        buildLiveContainer({ environment: "staging", buildBusiness, configDir: sb.configDir, repoRoot: sb.repoRoot, env: sb.env, logger: createMemoryLogger().logger, ...(network ? { network } : {}) });
      expect(await refusal(boot())).toEqual(["INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN@infrastructure.aws.endpointOverrides"]);
      // Without overrides (and without a trust reference, so nothing is called before the guard), path-style S3 is
      // still refused in staging by the guard itself.
      const noOverrides = structuredClone(staging) as typeof staging;
      (noOverrides.infrastructure as unknown as { aws: { endpointOverrides: null } }).aws.endpointOverrides = null;
      noOverrides.approvals.trustedSigningKeyRef = null;
      writeFileSync(stagingFile, JSON.stringify(noOverrides, null, 2));
      expect(await refusal(boot())).toContain("INFRASTRUCTURE_S3_PATH_STYLE_OUTSIDE_EMULATOR@infrastructure.aws.s3ForcePathStyle");
      expect(await refusal(boot({ resolve: privateResolver(["api.vendor.example.com"]) }))).toEqual(["NETWORK_OVERRIDE_OUTSIDE_SANDBOX@network"]);
    } finally {
      rmSync(stagingFile, { force: true });
    }
  });

  it("[FO-14-53][OPS-04] adversarial: a non-emulator override receives ZERO requests (refused before any client exists); control: an emulator-host override does receive the signed GetPublicKey", async () => {
    const outside = new RecordingListener(privateInterfaceAddress());
    const loopback = new RecordingListener("127.0.0.1");
    const outsideUrl = await outside.start();
    const loopbackUrl = await loopback.start();
    try {
      // A private (RFC 1918) host interface: routable inside the VPC, not an emulator host name.
      const cfg = sb.config();
      const aws = (cfg.infrastructure as unknown as { aws: { endpointOverrides: Record<string, string | null> } }).aws;
      aws.endpointOverrides.kms = outsideUrl;
      aws.endpointOverrides.secretsManager = outsideUrl;
      sb.writeConfig(cfg);
      const v = await refusal(bootLive(sb));
      expect(v).toEqual([
        "INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.kms",
        "INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR@infrastructure.aws.endpointOverrides.secretsManager",
      ]);
      expect(outside.received).toEqual([]);

      // Control (the probe is able to see a request): the same configuration with the KMS override on an emulator
      // host name reaches the listener with the SigV4-signed GetPublicKey of the approval trust anchor.
      const control = sb.config();
      (control.infrastructure as unknown as { aws: { endpointOverrides: Record<string, string | null> } }).aws.endpointOverrides.kms = loopbackUrl.replace("127.0.0.1", "localhost");
      sb.writeConfig(control);
      await bootLive(sb).then(
        ({ c }) => c.close(),
        () => undefined,
      );
      expect(loopback.received.some((r) => r.target === "TrentService.GetPublicKey" && r.authorizationHasCredential)).toBe(true);
      expect(outside.received).toEqual([]);
    } finally {
      await outside.stop();
      await loopback.stop();
      sb.writeConfig(sb.config());
    }
  });

  it("[AUTH-02][FO-19-06] adversarial: a connector profile that reuses an adapter's credential reference, or another committed environment's, refuses the environment", async () => {
    const shared = await createSecretValue(sb.sm, "conn-shared", JSON.stringify({ clientId: "client-read", clientSecret: "secret-read-composition-l2" }));
    const writeRef = await createSecretValue(sb.sm, "conn-write", JSON.stringify({ clientId: "client-write", clientSecret: "secret-write-composition-l2" }));
    mkdirSync(join(sb.repoRoot, "connectors"), { recursive: true });
    writeFileSync(join(sb.repoRoot, "connectors", "vendor-emulated.json"), JSON.stringify(emulatorProfile({ readRef: shared, writeRef, mutate: (p) => ({ ...p, tenantId: TENANT }) }), null, 2));
    const withProfile = () => {
      const cfg = sb.config();
      (cfg as Record<string, unknown>).connectors = { profileDirectory: "connectors", feeds: [] };
      return cfg;
    };
    const staging = join(sb.configDir, "staging.json");
    try {
      // Control: the profile alone is admitted (connectors.runtime CONFIGURED).
      sb.writeConfig(withProfile());
      const { c } = await bootLive(sb);
      try {
        expect(c.report.deployable).toBe(true);
        expect(c.connectorProfiles).toHaveLength(1);
        expect(c.activation.state("connectors.runtime")).toBe("CONFIGURED");
      } finally {
        await c.close();
      }

      // The same reference as the Salesforce adapter's credential in this environment.
      const reuse = withProfile();
      reuse.adapters.salesforce = { kind: "live", endpoint: "https://crm.vsp-composition.example.com", credentialRef: shared, authMethod: "oauth2_client_credentials", exceptionApprovalId: null, timeoutMs: 5_000, integrationApprovalId: null };
      sb.writeConfig(reuse);
      const v1 = await refusal(bootLive(sb));
      expect(v1).toContain("CREDENTIAL_REUSED_ACROSS_CONNECTORS@connectors.credentials.sandbox.adapter:salesforce");
      expect(v1.join(" ")).not.toContain("arn:aws");

      // The same reference in another committed environment's configuration (staging), not in this one.
      sb.writeConfig(withProfile());
      writeFileSync(staging, JSON.stringify({ ...sb.config(), environment: "staging", adapters: { salesforce: { ...reuse.adapters.salesforce } } }, null, 2));
      const v2 = await refusal(bootLive(sb));
      expect(v2).toContain("CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS@connectors.credentials.staging.adapter:salesforce");
    } finally {
      rmSync(staging, { force: true });
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-53][DATA-01] positive: assertions are signed by the configured KMS key (published key from KMS GetPublicKey), never by a development key", async () => {
    const { c } = await bootLive(sb);
    try {
      expect(c.identity.assertions.kind).toBe("live");
      const { keys } = await c.identity.assertions.jwks();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", kid: expect.stringMatching(/^kms-[0-9a-f]{24}$/) });
      expect(keys[0]).not.toHaveProperty("d");
    } finally {
      await c.close();
    }
  });

  it("[FO-14-53][OPS-01] failure injection: with the assertion key unusable in KMS (pending deletion) the signer fails closed (no fallback key)", async () => {
    const key = await createKmsKey(sb.kms);
    const cfg = sb.config();
    (cfg as Record<string, unknown>).signing = { assertionKeyRef: key, localDevKey: false };
    sb.writeConfig(cfg);
    try {
      const { c } = await bootLive(sb);
      try {
        // Fidelity: LocalStack 4.14 answers GetPublicKey for a DISABLED key; a key pending deletion is refused.
        await sb.kms.send(new ScheduleKeyDeletionCommand({ KeyId: key, PendingWindowInDays: 7 }));
        const err = await c.identity.assertions.jwks().then(() => null, (e: unknown) => e);
        expect(err).not.toBeNull();
        expect(err).toMatchObject({ reasonCode: expect.stringMatching(/^ASSERTION_|KMS_/) });
      } finally {
        await c.close();
      }
    } finally {
      sb.writeConfig(sb.config());
    }
  });
});
