/**
 * Layer-2 support for the live composition suite (WP-07). Every piece of the composition under test is the
 * production code (buildLiveContainer, buildLiveConsole, the live worker loops, the audit units) over the
 * local emulators, configured the way a sandbox deployment is configured:
 *
 *   - a sandbox PlatformConfig written to a scratch config directory: `infrastructure.aws.endpointOverrides`
 *     point the production AWS SDK v3 clients at DynamoDB Local, ElasticMQ, LocalStack (KMS, Secrets Manager)
 *     and MinIO (emulator host names only: the guard accepts overrides in sandbox and refuses them anywhere
 *     else, FO-14-53);
 *   - substrate created per run with uniqueName(): a PostgreSQL 16 database with every migration (its
 *     connection string is a LocalStack Secrets Manager secret, as the runtime login is in a deployment), the
 *     DynamoDB session and route-audit journal tables, the SQS outbox queue, KMS SIGN_VERIFY keys (assertions,
 *     the approval trust anchor), a symmetric ENCRYPT_DECRYPT key for the audit sink (never a signing key) and the
 *     request-hash / OTP peppers and console sealer key as secrets;
 *   - approval records signed with KMS Sign (ECDSA_SHA_256 over the canonical record) in a scratch repository
 *     root's approvals/ directory, verified by the live container with KmsTrustedKeyResolver (FO-14-56).
 *
 * Test plumbing, labelled (none of it is a unit fake, and nothing here imports a LOCAL FIXTURE module):
 *   - SYNTHETIC host names under example.com (RFC 2606 documentation domain; routable names, so the live-adapter
 *     rules accept them) that the SANDBOX-ONLY resolver of the live container (`network.resolve`) maps to a
 *     private (RFC 1918) host interface, where the test's TLS front proxy or emulator listens with a certificate
 *     from a per-run test CA (`network.tlsCa`). The production transport still applies the address-class,
 *     allowlist, egress and TLS checks; staging and production refuse both overrides.
 *   - TlsFrontProxy: a TLS-terminating HTTP proxy that serves the shared Keycloak under such a name (the shared
 *     container is never reconfigured or stopped; stopping the proxy is the IdP outage).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { CreateKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import type { KMSClient } from "@aws-sdk/client-kms";
import { CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { buildBusiness } from "../../../src/business/index.js";
import type { BuildBusiness } from "../../../src/business/contract.js";
import { approvalSigningPayload } from "../../../src/config/approvals.js";
import { classifyAddress } from "../../../src/connectors/http/address.js";
import type { ResolvedAddress } from "../../../src/connectors/http/transport.js";
import { buildLiveContainer } from "../../../src/main/live-container.js";
import type { LiveContainer, LiveContainerOptions } from "../../../src/main/live-container.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import type { ApprovalRecord, ApprovalScope } from "../../../src/protocol/index.js";
import type { Clock } from "../../../src/shared/clock.js";
import { ConfigurationRejectedError } from "../../../src/shared/errors.js";
import { awsQueueUrl, createIntegrationDb, dynamoClient, kmsClient, postgresUrl, secretsClient, sqsClient, uniqueName } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { PLATFORM_ROOT, localEnv } from "../_harness/env.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { createJournalTable, createKvTable } from "../substrate/seams.js";

/** The emulated AWS services of every composition test (plus Keycloak for the console). */
export const SUBSTRATE = ["postgres", "dynamodb", "elasticmq", "localstack"] as const;
export const REGION = "us-east-1";
export const TENANT = "tnt_synthTenantConnector01";
/** SYNTHETIC routable names (RFC 2606) the sandbox-only resolver maps to the private host interface. */
export const IDP_HOST = "idp.vsp-composition.example.com";
export const OTEL_HOST = "otel.vsp-composition.example.com";

/* ------------------------------------------------------------------------ */
/* Network plumbing                                                          */
/* ------------------------------------------------------------------------ */

/** A private IPv4 address of a host interface (the compose bridge while the local composition runs). */
export function privateInterfaceAddress(): string {
  // The compose project's bridge (br-*) first: docker0 only gets its address while a container uses the default
  // bridge, so an address taken from it could vanish between two calls of one test.
  const entries = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(!a.startsWith("br-")) - Number(!b.startsWith("br-")) || a.localeCompare(b));
  for (const [, list] of entries) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && classifyAddress(a.address) === "PRIVATE") return a.address;
  }
  // A precondition of Layer 2 (the compose bridge), never a skip: an unrun check is not a pass (OPS-03).
  throw new Error("LAYER2_PRIVATE_INTERFACE_MISSING: no private IPv4 host interface; start the composition with make up PROFILE=core");
}

/** The sandbox-only resolver: each SYNTHETIC name answers the private host interface; anything else is refused. */
export function privateResolver(hosts: readonly string[], address = privateInterfaceAddress()): (hostname: string) => Promise<ResolvedAddress[]> {
  const known = new Set(hosts.map((h) => h.toLowerCase()));
  return async (hostname: string) => {
    if (!known.has(hostname.toLowerCase())) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  };
}

export interface TestPki {
  caPem: string;
  certPem: string;
  keyPem: string;
  dir: string;
  dispose(): void;
}

/** A per-run CA and one leaf certificate (P-256, serverAuth) for the given DNS names. */
export function createPki(hosts: readonly string[]): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "vsp-composition-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=VSP Layer-2 composition test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  run(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${hosts[0] ?? "composition.example.com"}`, "-out", "leaf.csr"]);
  writeFileSync(join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((h) => `DNS:${h}`).join(",")}\n`);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { dir, caPem: read("ca.pem"), certPem: read("leaf.pem"), keyPem: read("leaf.key"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * TLS-terminating proxy on the private host interface: serves an upstream https service (the shared Keycloak on
 * its loopback port, verified with the checkout's local CA) under a SYNTHETIC name. Counts forwarded requests by
 * path so a test can tell which endpoints the production adapters called.
 */
export class TlsFrontProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  readonly paths: string[] = [];
  port = 0;

  constructor(
    private readonly pki: TestPki,
    /** The upstream's loopback port and TLS server name; the client's Host header is passed through. */
    private readonly upstream: { port: number; servername: string },
    private readonly bindAddress = privateInterfaceAddress(),
  ) {}

  get address(): string {
    return this.bindAddress;
  }

  async start(): Promise<number> {
    const upstreamCa = readFileSync(localEnv().caFile, "utf8");
    const server = createHttpsServer({ cert: this.pki.certPem, key: this.pki.keyPem }, (req: IncomingMessage, res: ServerResponse) => {
      this.paths.push((req.url ?? "").split("?")[0] ?? "");
      const up = httpsRequest(
        { host: "127.0.0.1", port: this.upstream.port, method: req.method, path: req.url, headers: { ...req.headers }, servername: this.upstream.servername, ca: upstreamCa },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.bindAddress, () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x3D;/g, "=").replace(/&#61;/g, "=").replace(/&quot;/g, '"');

/**
 * The test's user agent for the hosted IdP login (test plumbing): follows the authorization URL the BACKEND
 * produced through the front proxy, fills the password and OTP forms (RFC 6238 computed locally) and stops at the
 * redirect, handing code and state back to the backend. Only the SYNTHETIC IdP origin is ever contacted.
 */
export class ProxyBrowser {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly o: { origin: string; address: string; port: number; caPem: string; totp: (key: Buffer) => string }) {}

  private send(url: URL, method: "GET" | "POST", body?: string): Promise<RawResponse> {
    if (url.origin !== this.o.origin) throw new Error(`BROWSER_UNEXPECTED_ORIGIN: ${url.origin}`);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: this.o.address,
          port: this.o.port,
          servername: url.hostname,
          ca: this.o.caPem,
          method,
          path: `${url.pathname}${url.search}`,
          headers: {
            host: url.host,
            cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            for (const c of res.headers["set-cookie"] ?? []) {
              const pair = c.split(";")[0] ?? "";
              const eq = pair.indexOf("=");
              if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async signIn(authorizationUrl: string, user: { username: string; password: string; totpSecret: string | null }, redirectUri: string): Promise<{ code: string; state: string } | { refused: string }> {
    let res = await this.send(new URL(authorizationUrl), "GET");
    for (let step = 0; step < 8; step++) {
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (res.status === 302 || res.status === 303) {
        if (location?.startsWith(redirectUri)) {
          const back = new URL(location);
          const code = back.searchParams.get("code");
          return code ? { code, state: back.searchParams.get("state") ?? "" } : { refused: back.searchParams.get("error") ?? "NO_CODE" };
        }
        if (!location) return { refused: `REDIRECT_WITHOUT_LOCATION_${res.status}` };
        res = await this.send(new URL(location, this.o.origin), "GET");
        continue;
      }
      const page = res.body;
      const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
      if (!action) return { refused: /<title>([^<]*)/.exec(page)?.[1]?.trim() || `PAGE_${res.status}` };
      const form = new URLSearchParams();
      if (/name="password"/.test(page)) {
        if (/name="username"/.test(page)) form.set("username", user.username);
        form.set("password", user.password);
        form.set("credentialId", "");
      } else if (/name="otp"/.test(page)) {
        if (!user.totpSecret) return { refused: "OTP_REQUESTED_WITHOUT_CREDENTIAL" };
        form.set("otp", this.o.totp(Buffer.from(user.totpSecret, "utf8")));
      } else {
        return { refused: "LOGIN_PAGE_UNEXPECTED" };
      }
      res = await this.send(new URL(decodeHtml(action), this.o.origin), "POST", form.toString());
    }
    return { refused: "LOGIN_DID_NOT_COMPLETE" };
  }
}

/* ------------------------------------------------------------------------ */
/* Emulated AWS resources                                                    */
/* ------------------------------------------------------------------------ */

/** A LocalStack KMS key; returns its key ARN (the form PlatformConfig references). */
export async function createKmsKey(kms: KMSClient, o: { usage?: "SIGN_VERIFY" | "ENCRYPT_DECRYPT"; spec?: "ECC_NIST_P256" | "RSA_2048" | "SYMMETRIC_DEFAULT" } = {}): Promise<string> {
  const usage = o.usage ?? "SIGN_VERIFY";
  const spec = o.spec ?? (usage === "SIGN_VERIFY" ? "ECC_NIST_P256" : "RSA_2048");
  const out = await kms.send(new CreateKeyCommand({ KeyUsage: usage, KeySpec: spec, Description: "vsp layer-2 composition (synthetic)" }));
  const arn = out.KeyMetadata?.Arn;
  if (!arn) throw new Error("LOCALSTACK_KMS_NO_ARN");
  return arn;
}

/** A LocalStack Secrets Manager secret holding `value`; returns its ARN. */
export async function createSecretValue(sm: SecretsManagerClient, prefix: string, value: string): Promise<string> {
  const out = await sm.send(new CreateSecretCommand({ Name: uniqueName(`vsp-it/composition/${prefix}`), SecretString: value }));
  if (!out.ARN) throw new Error("LOCALSTACK_SECRET_NO_ARN");
  return out.ARN;
}

/** An ElasticMQ queue; returns the AWS-form queue URL the configuration holds. */
export async function createQueue(sqs: SQSClient, prefix: string): Promise<string> {
  const name = uniqueName(prefix);
  await sqs.send(new CreateQueueCommand({ QueueName: name }));
  return awsQueueUrl(name);
}

/** An approval record signed with KMS Sign (ECDSA_SHA_256, DER) over its canonical payload. */
export async function kmsSignedApproval(kms: KMSClient, keyArn: string, o: { scope: ApprovalScope; role?: ApprovalRecord["approver"]["role"]; environment?: ApprovalRecord["environment"]; now?: Date; approvalId?: string }): Promise<ApprovalRecord> {
  const now = o.now ?? new Date();
  const unsigned: ApprovalRecord = {
    approvalId: o.approvalId ?? `apr_synth${randomBytes(8).toString("hex")}`,
    approver: { name: "Synthetic Approver (Layer 2)", role: o.role ?? "identity_owner" },
    scope: o.scope,
    scopeDetail: "SYNTHETIC Layer-2 composition approval: sandbox emulators only, no real vendor, no real tenant.",
    environment: o.environment ?? "sandbox",
    grantedAt: new Date(now.getTime() - 3_600_000).toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
    evidenceRef: "evidence://synthetic/layer2/composition",
    signature: null,
  };
  const out = await kms.send(new SignCommand({ KeyId: keyArn, Message: Buffer.from(approvalSigningPayload(unsigned), "utf8"), MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }));
  if (!out.Signature) throw new Error("LOCALSTACK_KMS_NO_SIGNATURE");
  return { ...unsigned, signature: `ecdsa-p256-sha256:${Buffer.from(out.Signature).toString("base64")}` };
}

/* ------------------------------------------------------------------------ */
/* The sandbox                                                               */
/* ------------------------------------------------------------------------ */

export type SandboxConfig = Record<string, unknown> & {
  adapters: Record<string, Record<string, unknown>>;
  approvals: { directory: string; required: string[]; trustedSigningKeyRef: string | null };
  infrastructure: Record<string, unknown> & { secrets: Record<string, string | null>; privateNetworkHosts: string[] };
  egress: { policyVersion: string; destinations: Record<string, unknown>[] };
};

export interface Sandbox {
  l2: Layer2Context;
  idb: IntegrationDb;
  kms: KMSClient;
  sm: SecretsManagerClient;
  sqs: SQSClient;
  /** Scratch directories: the config directory and the repository root (approvals/, connectors/). */
  configDir: string;
  repoRoot: string;
  /** KMS key ARNs: the assertion signing key and the approval trust anchor. */
  keys: { assertion: string; trust: string };
  refs: { database: string; pepper: string; otpPepper: string; sealer: string };
  tables: { sessions: string; journal: string };
  queues: { outbox: string };
  /** Process environment of the composed units (emulator credentials, mutation fence). */
  env: Record<string, string>;
  /** The base sandbox configuration (a fresh copy on each call). */
  config(): SandboxConfig;
  writeConfig(cfg: SandboxConfig): void;
  writeApproval(record: ApprovalRecord): void;
  clearApprovals(): void;
  close(): Promise<void>;
}

/** Provisions the emulated substrate of one sandbox deployment and its scratch configuration. */
export async function provisionSandbox(l2: Layer2Context, o: { tenantId?: string } = {}): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "vsp-composition-"));
  const configDir = join(root, "config");
  const repoRoot = join(root, "repo");
  mkdirSync(configDir);
  mkdirSync(join(repoRoot, "approvals"), { recursive: true });
  const idb = await createIntegrationDb(l2, 4);
  try {
    const kms = kmsClient(l2);
    const sm = secretsClient(l2);
    const sqs = sqsClient(l2);
    const dynamo = dynamoClient(l2);
    // The audit sink's SSE-KMS key is its own symmetric ENCRYPT_DECRYPT key (never a signing key).
    const [assertion, trust, auditSinkKey] = await Promise.all([createKmsKey(kms), createKmsKey(kms), createKmsKey(kms, { usage: "ENCRYPT_DECRYPT", spec: "SYMMETRIC_DEFAULT" })]);
    const database = await createSecretValue(sm, "db-runtime", postgresUrl(l2, idb.name));
    const pepper = await createSecretValue(sm, "pepper", randomBytes(32).toString("base64"));
    const otpPepper = await createSecretValue(sm, "otp-pepper", randomBytes(32).toString("base64"));
    const sealer = await createSecretValue(sm, "console-sealer", randomBytes(32).toString("base64"));
    const sessions = await createKvTable(dynamo, uniqueName("vsp-it-comp-sessions"));
    const journal = await createJournalTable(dynamo, uniqueName("vsp-it-comp-raj"));
    dynamo.destroy();
    const outbox = await createQueue(sqs, "vsp-it-comp-outbox");
    const tenantId = o.tenantId ?? TENANT;
    const base = JSON.parse(readFileSync(join(PLATFORM_ROOT, "config", "sandbox.json"), "utf8")) as Record<string, unknown>;
    const env = { AWS_ACCESS_KEY_ID: localEnv().awsAccessKeyId, AWS_SECRET_ACCESS_KEY: localEnv().awsSecretAccessKey };
    const config = (): SandboxConfig =>
      structuredClone({
        ...base,
        $comment: "SYNTHETIC Layer-2 sandbox configuration (emulators only; written by test/integration/composition/support.ts).",
        tenantId,
        // The emulated contact centre has no interaction lookup (contact_center.talkdesk NOT_CONFIGURED): tool calls
        // carry the session reference in the trusted header of the integration's own transport.
        sessionBinding: { mode: "trusted_header", sessionTtlSeconds: 1800, exceptionApprovalId: null },
        adapters: {},
        approvals: { directory: "approvals", required: [], trustedSigningKeyRef: trust },
        signing: { assertionKeyRef: assertion, localDevKey: false },
        database: { engine: "pg", connectionRef: database },
        sessionStore: { kind: "dynamodb", tableName: sessions },
        retention: { TRANSIENT_CONVERSATION: 30, BUSINESS_RECORD: 2555, RESTRICTED_QA_MEDIA: 90, SECURITY_AUDIT: 2555 },
        infrastructure: {
          aws: {
            region: REGION,
            endpointOverrides: { dynamodb: l2.url("dynamodb", 8000), sqs: l2.url("elasticmq", 9324), s3: null, kms: l2.url("localstack", 4566), secretsManager: l2.url("localstack", 4566), sts: null },
            s3ForcePathStyle: true,
          },
          privateNetworkHosts: [],
          outbox: { queueUrl: outbox, fifo: false, deadLetterQueueUrl: null },
          routeAuditJournalTable: journal,
          auditSink: { bucket: "vsp-it-composition-audit", expectedBucketOwner: "123456789012", keyPrefix: "audit/", objectLockMode: "GOVERNANCE", kmsKeyId: auditSinkKey },
          auditExport: null,
          secrets: { requestHashPepperRef: pepper, otpPepperRef: otpPepper, consoleSessionSealerRef: sealer },
          ingressPayloadKeyId: null,
        },
        observability: { contentAttributes: "DISABLED", otlp: null },
        egress: { policyVersion: "egress-composition-l2-1", destinations: [] },
      }) as SandboxConfig;
    const sb: Sandbox = {
      l2,
      idb,
      kms,
      sm,
      sqs,
      configDir,
      repoRoot,
      keys: { assertion, trust },
      refs: { database, pepper, otpPepper, sealer },
      tables: { sessions, journal },
      queues: { outbox },
      env,
      config,
      writeConfig(cfg) {
        writeFileSync(join(configDir, "sandbox.json"), JSON.stringify(cfg, null, 2));
      },
      writeApproval(record) {
        writeFileSync(join(repoRoot, "approvals", `${record.approvalId}.json`), JSON.stringify(record, null, 2));
      },
      clearApprovals() {
        rmSync(join(repoRoot, "approvals"), { recursive: true, force: true });
        mkdirSync(join(repoRoot, "approvals"), { recursive: true });
      },
      async close() {
        kms.destroy();
        sm.destroy();
        sqs.destroy();
        await idb.drop().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      },
    };
    sb.writeConfig(config());
    return sb;
  } catch (err) {
    await idb.drop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

export interface BootOptions {
  clock?: Clock;
  unit?: LiveContainerOptions["unit"];
  network?: LiveContainerOptions["network"];
  env?: Record<string, string>;
  buildBusiness?: BuildBusiness;
  /** Memory logger to use (a test that expects a refusal keeps it to read the events). */
  memory?: ReturnType<typeof createMemoryLogger>;
}

/** buildLiveContainer over the sandbox (memory logger: events are asserted, nothing is printed). */
export async function bootLive(sb: Sandbox, o: BootOptions = {}): Promise<{ c: LiveContainer; records: ReturnType<typeof createMemoryLogger>["records"] }> {
  const { logger, records } = o.memory ?? createMemoryLogger();
  const c = await buildLiveContainer({
    environment: "sandbox",
    buildBusiness: o.buildBusiness ?? buildBusiness,
    configDir: sb.configDir,
    repoRoot: sb.repoRoot,
    env: { ...sb.env, ...(o.env ?? {}) },
    logger,
    databasePoolSize: 4,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.unit ? { unit: o.unit } : {}),
    ...(o.network ? { network: o.network } : {}),
  });
  return { c, records };
}

/** The violations of a refused composition (fails the test when it was not refused). */
export async function refusal(p: Promise<unknown>): Promise<string[]> {
  try {
    const x = await p;
    if (x && typeof x === "object" && "c" in x) await (x as { c: LiveContainer }).c.close();
    throw new Error("COMPOSITION_NOT_REFUSED");
  } catch (err) {
    if (err instanceof ConfigurationRejectedError) return err.violations;
    throw err;
  }
}
