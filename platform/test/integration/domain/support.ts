/**
 * Layer-2 support for the domain suite (WP-23). Everything on the platform side is production code: the domain
 * adapters built by `createDomainAdapters` (admitted ConnectorProfiles and bindings), the WP-06 connector runtime,
 * the egress-classified transport over TLS (a private test CA generated with openssl; server names verified), the
 * Secrets Manager resolver over LocalStack, and the LedgerActionService on postgres:16. The system of record is the
 * reference business API container of the composition (profile `domain`), reached through dedicated loopback
 * endpoints it opens per test (so connection-level faults stay inside one test) and driven through its fault-control
 * listener (local/ci only). SYNTHETIC data only: opaque ids, display names without real people, no phone numbers.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateSecretCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { SecretsManagerSecretResolver } from "../../../src/connectors/secrets/resolver.js";
import { createDomainAdapters } from "../../../src/domain/factory.js";
import type { DomainAdapters } from "../../../src/domain/factory.js";
import { referenceBinding, referenceProfile } from "../../../src/domain/profiles.js";
import type { ReferenceDialect, ReferenceSystem } from "../../../src/domain/profiles.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { ActionConfirmation, AuthContext, IntegrationIdentity, PolicyDecision } from "../../../src/protocol/index.js";
import type { Clock } from "../../../src/shared/clock.js";
import { addMs, iso, systemClock } from "../../../src/shared/clock.js";
import { newId, newSessionRef, newTurnId } from "../../../src/shared/ids.js";
import { secretsClient, uniqueName } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";

/** Services every domain test uses: the reference API, Secrets Manager (LocalStack) and postgres:16 (ledger). */
export const DOMAIN_SERVICES = ["reference-business-api", "localstack", "postgres"] as const;

export const SYSTEMS: readonly ReferenceSystem[] = ["scheduling", "billing", "claims", "provider", "referrals", "legacy"];

const SCOPES: Readonly<Record<ReferenceSystem, { read: string; write: string | null }>> = {
  scheduling: { read: "scheduling:read", write: "scheduling:write" },
  billing: { read: "billing:read", write: "billing:write" },
  claims: { read: "claims:read", write: null },
  provider: { read: "provider:read", write: null },
  referrals: { read: "referrals:read", write: null },
  legacy: { read: "legacy:read", write: "legacy:write" },
};

/** Opaque synthetic id in the reference API's form (`<prefix>_<base64url>`). */
export const opaque = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;

// ------------------------------------------------------------------ the reference API container

export interface RefbizPorts {
  api: number;
  admin: number;
  health: number;
}

/**
 * Ports of the reference API instance the suite runs against: the composition's container, read from its own
 * configuration (it runs with host networking). `VSP_REFBIZ_PORTS=<api>:<admin>:<health>` names a private loopback
 * instance of the checkout's service instead (a developer run while the shared container still serves an older
 * checkout; never the default). Either way `provisionTenant` refuses an instance whose code is not the checkout's.
 */
export function refbizPorts(l2: Layer2Context): RefbizPorts {
  const override = process.env.VSP_REFBIZ_PORTS;
  if (override !== undefined && override !== "") {
    const parts = override.split(":").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n <= 0 || n > 65_535)) throw new Error("VSP_REFBIZ_PORTS_INVALID: expected <api>:<admin>:<health>");
    return { api: parts[0] as number, admin: parts[1] as number, health: parts[2] as number };
  }
  const container = l2.service("reference-business-api").container;
  const env = JSON.parse(execFileSync("docker", ["inspect", container, "--format", "{{json .Config.Env}}"], { encoding: "utf8" })) as string[];
  const get = (k: string): number => {
    const v = env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`REFBIZ_PORT_UNKNOWN: ${k}`);
    return n;
  };
  if (!env.includes("REFBIZ_FAULT_CONTROL=enabled")) throw new Error("REFBIZ_FAULT_CONTROL_DISABLED: the domain suite needs the local fault-control listener");
  return { api: get("REFBIZ_API_PORT"), admin: get("REFBIZ_ADMIN_PORT"), health: get("REFBIZ_HEALTH_PORT") };
}

/**
 * The code digest of the checkout's reference API sources (the service computes the same over the modules it runs:
 * services/reference-business-api/src/build.ts, scheme refbiz.code.v1).
 */
export function checkoutCodeDigest(): string {
  const dir = fileURLToPath(new URL("../../../../services/reference-business-api/src/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  const h = createHash("sha256").update("refbiz.code.v1\n");
  for (const f of files) h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex");
}

let codeChecked: Promise<void> | null = null;

/** Refuses to run against an instance that does not serve the checkout's service code (a stale container). */
export function assertCheckoutCode(admin: RefbizAdmin): Promise<void> {
  codeChecked ??= admin.call<{ codeDigest: string | null }>("GET", "/__admin/build").then(
    (b) => {
      if (b.codeDigest !== checkoutCodeDigest()) throw new Error("REFBIZ_STALE_CODE: the reference-business-api instance does not run the checkout's service code; recreate it (the composition runs the checkout from a bind mount) or point VSP_REFBIZ_PORTS at a private instance");
    },
    () => {
      throw new Error("REFBIZ_STALE_CODE: the reference-business-api instance reports no code digest (an older service); recreate it");
    },
  );
  return codeChecked;
}

/**
 * The database the reference API instance stores its records in: the container's own configuration, or with
 * VSP_REFBIZ_PORTS the private instance's VSP_REFBIZ_DATABASE (the tests that hold row locks as another writer use it).
 */
export function refbizDatabase(l2: Layer2Context): string {
  if (process.env.VSP_REFBIZ_PORTS) {
    const name = process.env.VSP_REFBIZ_DATABASE ?? "";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("VSP_REFBIZ_DATABASE_INVALID: name the private instance's database");
    return name;
  }
  const container = l2.service("reference-business-api").container;
  const env = JSON.parse(execFileSync("docker", ["inspect", container, "--format", "{{json .Config.Env}}"], { encoding: "utf8" })) as string[];
  return env.find((e) => e.startsWith("REFBIZ_DATABASE_NAME="))?.slice("REFBIZ_DATABASE_NAME=".length) ?? "refbiz";
}

export interface FaultView {
  faultId: string;
  operation: string;
  kind: string;
  hits: number;
  remaining: number | null;
}
export interface EndpointView {
  endpointId: string;
  port: number;
  mode: "NORMAL" | "REFUSE_CONNECTIONS" | "STALL_HANDSHAKE";
  connections: number;
  stalled: number;
  refusedWindows: number;
}
export interface EffectRow {
  seq: number;
  requestId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  beforeVersion: string | null;
  afterVersion: string;
}
export interface RequestRow {
  operation: string;
  keyRef: string | null;
  status: number;
}

/** Client of the fault-control listener (plain HTTP on 127.0.0.1; exists only in local/ci). */
/** A change request as the system stores it (admin view; content-free). */
export interface StoredChange {
  state: string;
  failure_code: string | null;
  resource_id: string | null;
  receipt_id: string | null;
  not_after: string | null;
}

export class RefbizAdmin {
  constructor(readonly port: number) {}

  async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status >= 300) throw new Error(`REFBIZ_ADMIN_${res.status}: ${method} ${path.replace(/[A-Za-z0-9_-]{16,}/g, "<id>")} ${text.slice(0, 80)}`);
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  account(input: { dialect: ReferenceDialect; timeZone: string; visibilityWindowMs: number; lookupLagMs: number; region?: string }): Promise<{ accountId: string }> {
    return this.call("POST", "/__admin/accounts", { region: input.region ?? "us-east-1", ...input });
  }
  client(accountId: string, scopes: string[]): Promise<{ clientId: string; clientSecret: string }> {
    return this.call("POST", `/__admin/accounts/${accountId}/clients`, { scopes });
  }
  seed(accountId: string, seed: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", `/__admin/accounts/${accountId}/seed`, seed);
  }
  registerHost(hostname: string, certPem: string, keyPem: string): Promise<unknown> {
    return this.call("POST", "/__admin/tls/hosts", { hostname, certPem, keyPem });
  }
  openEndpoint(): Promise<EndpointView> {
    return this.call("POST", "/__admin/endpoints");
  }
  endpoint(endpointId: string): Promise<EndpointView> {
    return this.call("GET", `/__admin/endpoints/${endpointId}`);
  }
  setMode(endpointId: string, mode: EndpointView["mode"]): Promise<EndpointView> {
    return this.call("PUT", `/__admin/endpoints/${endpointId}/mode`, { mode });
  }
  closeEndpoint(endpointId: string): Promise<unknown> {
    return this.call("DELETE", `/__admin/endpoints/${endpointId}`);
  }
  arm(accountId: string, fault: Record<string, unknown>): Promise<{ faultId: string }> {
    return this.call("POST", `/__admin/accounts/${accountId}/faults`, fault);
  }
  async faults(accountId: string): Promise<FaultView[]> {
    return (await this.call<{ faults: FaultView[] }>("GET", `/__admin/accounts/${accountId}/faults`)).faults;
  }
  clearFaults(accountId: string): Promise<unknown> {
    return this.call("DELETE", `/__admin/accounts/${accountId}/faults`);
  }
  barrier(accountId: string, b: { operation: string; resourceId: string; parties: number; timeoutMs: number }): Promise<{ barrierId: string }> {
    return this.call("POST", `/__admin/accounts/${accountId}/barriers`, b);
  }
  async barriers(accountId: string): Promise<{ barrierId: string; arrived: number; released: boolean; timedOut: boolean }[]> {
    return (await this.call<{ barriers: { barrierId: string; arrived: number; released: boolean; timedOut: boolean }[] }>("GET", `/__admin/accounts/${accountId}/barriers`)).barriers;
  }
  touchSlot(accountId: string, slotId: string): Promise<{ version: string }> {
    return this.call("POST", `/__admin/accounts/${accountId}/slots/${slotId}/touch`);
  }
  async effects(accountId: string, resourceId?: string): Promise<EffectRow[]> {
    const q = resourceId === undefined ? "" : `?resourceId=${resourceId}`;
    return (await this.call<{ effects: EffectRow[] }>("GET", `/__admin/accounts/${accountId}/effects${q}`)).effects;
  }
  /** A legacy reference's reservation / fence state as stored (the reserving dispatch id is never returned). */
  async legacyReference(accountId: string, externalRef: string): Promise<{ state: string; reserved: boolean; posted_at: string | null; fenced_at: string | null } | null> {
    return this.call<{ state: string; reserved: boolean; posted_at: string | null; fenced_at: string | null }>("GET", `/__admin/accounts/${accountId}/legacy-references/${externalRef}`).catch((e: unknown) => {
      if (e instanceof Error && e.message.startsWith("REFBIZ_ADMIN_404")) return null;
      throw e;
    });
  }
  /** A change request as stored, regardless of its lookup visibility (the system's own view). */
  async changeRequest(accountId: string, requestId: string): Promise<StoredChange | null> {
    return this.call<StoredChange>("GET", `/__admin/accounts/${accountId}/change-requests/${requestId}`).catch((e: unknown) => {
      if (e instanceof Error && e.message.startsWith("REFBIZ_ADMIN_404")) return null;
      throw e;
    });
  }
  async requests(accountId: string): Promise<RequestRow[]> {
    return (await this.call<{ requests: RequestRow[] }>("GET", `/__admin/accounts/${accountId}/requests`)).requests;
  }
  forget(accountId: string): Promise<unknown> {
    return this.call("DELETE", `/__admin/accounts/${accountId}`);
  }
}

// ------------------------------------------------------------------ PKI

export interface DomainPki {
  caPem: string;
  leaf: (host: string) => { certPem: string; keyPem: string };
  dispose(): void;
}

/** A private CA (P-256) for one test file; leaf certificates per host name with serverAuth and the DNS SAN. */
export function createDomainPki(): DomainPki {
  const dir = mkdtempSync(join(tmpdir(), "vsp-domain-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=VSP Layer-2 domain test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"]);
  let n = 0;
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    leaf(host: string) {
      const f = `leaf${n++}`;
      run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${f}.key`]);
      run(["req", "-new", "-key", `${f}.key`, "-subj", `/CN=${host}`, "-out", `${f}.csr`]);
      writeFileSync(join(dir, `${f}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`);
      run(["x509", "-req", "-in", `${f}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", `${f}.ext`, "-out", `${f}.pem`]);
      return { certPem: readFileSync(join(dir, `${f}.pem`), "utf8"), keyPem: readFileSync(join(dir, `${f}.key`), "utf8") };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ------------------------------------------------------------------ one synthetic tenant

export interface TenantOptions {
  systems?: readonly ReferenceSystem[];
  dialect?: ReferenceDialect;
  timeZone?: string;
  /** The system's documented window (account) and the binding's (defaults to the same). */
  visibilityWindowMs?: number;
  bindingWindowMs?: number;
  clockSkewAllowanceMs?: number;
  lookupLagMs?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  retryBudget?: number;
  clock?: Clock;
  /** Dialect the reviewed profile maps (defaults to the account's): a mismatch is schema drift. */
  profileDialect?: ReferenceDialect;
  /** Approved synthetic record per system (health / capability probe). */
  syntheticRecords?: Partial<Record<ReferenceSystem, string>>;
  /** Whether the bindings declare the system's fence (default: yes; without it no absence is ever definitive). */
  fence?: boolean;
}

export interface Tenant {
  accountId: string;
  tenantId: string;
  admin: RefbizAdmin;
  adapters: DomainAdapters;
  hosts: Record<string, string>;
  endpoints: Record<string, EndpointView>;
  metrics: InMemoryMetrics;
  secrets: SecretsManagerSecretResolver;
  profiles: Record<string, ReturnType<typeof referenceProfile>>;
  /** Everything needed to compose the same adapters in another process (crash tests), as JSON. */
  spec: AdapterSpec;
  dispose(): Promise<void>;
}

/** Serializable composition input of a tenant's domain adapters (no secret values: credential references only). */
export interface AdapterSpec {
  tag: string;
  systems: ReferenceSystem[];
  hosts: Record<string, string>;
  ports: Record<string, number>;
  caPem: string;
  configs: { profile: unknown; binding: unknown }[];
}

/**
 * Composes the production domain adapters of `spec`: the egress guard for exactly the tenant's hosts, the TLS
 * transport over the per-system loopback endpoints (server names verified against the test CA), the Secrets
 * Manager resolver and `createDomainAdapters` (profile and binding admission).
 */
export function composeAdapters(spec: AdapterSpec, sm: SecretsManagerClient, clock: Clock, metrics: InMemoryMetrics): { adapters: DomainAdapters; secrets: SecretsManagerSecretResolver } {
  const secrets = new SecretsManagerSecretResolver(sm, { clock, cacheTtlMs: 300_000, metrics });
  const egress = new EgressGuard(
    {
      policyVersion: `egress-domain-${spec.tag}`,
      destinations: spec.systems.map((key) => ({
        destinationId: `egr_refbiz_${key}`,
        kind: "SYSTEM_OF_RECORD" as const,
        hosts: [spec.hosts[key] as string],
        allowedClasses: ["INTERNAL", "FINANCIAL", "PHI"],
        coverage: { baaRef: "baa-synthetic-reference-api", approvalId: "apr_synthDomainApproval1" },
        environments: ["local", "ci"],
        adapterKind: "live" as const,
      })),
    },
    { environment: "local" },
  );
  const transport = new ConnectorHttpTransport({
    environment: "local",
    egress,
    loopbackRoutes: new Map(spec.systems.map((key) => [spec.hosts[key] as string, { port: spec.ports[key] as number, tls: true }])),
    tlsCa: [spec.caPem],
    metrics,
  });
  return { adapters: createDomainAdapters({ environment: "local", transport, secrets, clock, metrics, systems: spec.configs }), secrets };
}

/**
 * Provisions a synthetic tenant at the reference API (account, one OAuth client per system and access, a host and
 * a dedicated endpoint per system) and composes the production domain adapters for it.
 */
export async function provisionTenant(l2: Layer2Context, pki: DomainPki, o: TenantOptions = {}): Promise<Tenant> {
  const systems = o.systems ?? SYSTEMS;
  const ports = refbizPorts(l2);
  const admin = new RefbizAdmin(ports.admin);
  await assertCheckoutCode(admin);
  const window = o.visibilityWindowMs ?? 1_500;
  const timeZone = o.timeZone ?? "America/Chicago";
  const { accountId } = await admin.account({ dialect: o.dialect ?? "canonical", timeZone, visibilityWindowMs: window, lookupLagMs: o.lookupLagMs ?? 0 });
  const sm: SecretsManagerClient = secretsClient(l2);
  const clock = o.clock ?? systemClock;
  const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
  const secretArns: string[] = [];
  const hosts: Record<string, string> = {};
  const endpoints: Record<string, EndpointView> = {};
  const tag = randomBytes(4).toString("hex");
  const tenantId = opaque("tnt");
  const configs: { profile: unknown; binding: unknown }[] = [];
  const profiles: Record<string, ReturnType<typeof referenceProfile>> = {};
  const secretFor = async (scopes: string[], label: string): Promise<string> => {
    const c = await admin.client(accountId, scopes);
    const out = await sm.send(new CreateSecretCommand({ Name: uniqueName(`vsp-it/domain-${label}`), SecretString: JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret }) }));
    if (!out.ARN) throw new Error("LocalStack returned no ARN");
    secretArns.push(out.ARN);
    return out.ARN;
  };
  for (const key of systems) {
    const host = `${key}-${tag}.refbiz.test`;
    hosts[key] = host;
    const leaf = pki.leaf(host);
    await admin.registerHost(host, leaf.certPem, leaf.keyPem);
    endpoints[key] = await admin.openEndpoint();
    const sc = SCOPES[key];
    const readRef = await secretFor([sc.read], `${key}-read`);
    const writeRef = sc.write === null ? null : await secretFor([sc.write], `${key}-write`);
    const profile = referenceProfile(key, {
      tenantId,
      profileId: opaque("cnp"),
      occurredAt: iso(clock.now()),
      host,
      externalAccountRef: accountId,
      region: "us-east-1",
      readCredentialRef: readRef,
      writeCredentialRef: writeRef,
      writeMode: writeRef === null ? "READ_ONLY" : "SANDBOX_WRITE",
      dialect: key === "legacy" ? "legacy_codes" : (o.profileDialect ?? o.dialect ?? "canonical"),
      businessTimeZone: timeZone,
      addressClass: "PRIVATE_NETWORK",
      tlsCaRef: null,
      syntheticRecordId: o.syntheticRecords?.[key] ?? null,
      readTimeoutMs: o.readTimeoutMs ?? 2_000,
      writeTimeoutMs: o.writeTimeoutMs ?? 3_000,
      retryBudget: o.retryBudget ?? 1,
    });
    profiles[key] = profile;
    configs.push({
      profile,
      binding: referenceBinding(key, profile, { bindingId: opaque("dbn"), visibilityWindowMs: o.bindingWindowMs ?? window, clockSkewAllowanceMs: o.clockSkewAllowanceMs ?? 250, fence: o.fence, paymentPortalPath: "/billing/pay/{invoiceId}" }),
    });
  }
  const spec: AdapterSpec = { tag, systems: [...systems], hosts, ports: Object.fromEntries(systems.map((key) => [key, (endpoints[key] as EndpointView).port])), caPem: pki.caPem, configs };
  const { adapters, secrets } = composeAdapters(spec, sm, clock, metrics);
  return {
    accountId,
    tenantId,
    admin,
    adapters,
    hosts,
    endpoints,
    metrics,
    secrets,
    profiles,
    spec,
    async dispose() {
      for (const ep of Object.values(endpoints)) await admin.closeEndpoint(ep.endpointId).catch(() => undefined);
      await admin.forget(accountId).catch(() => undefined);
      for (const arn of secretArns) await sm.send(new DeleteSecretCommand({ SecretId: arn, ForceDeleteWithoutRecovery: true })).catch(() => undefined);
    },
  };
}

// ------------------------------------------------------------------ synthetic records

export interface World {
  client: string;
  otherClient: string;
  provider: string;
  otherProvider: string;
  practice: string;
  appointment: string;
  otherAppointment: string;
  slots: string[];
  otherProviderSlot: string;
  invoice: string;
  paidInvoice: string;
  claim: string;
  referral: string;
  authorization: string;
}

const inDays = (d: number, hour = 15): string => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};
const day = (d: number): string => inDays(d).slice(0, 10);

/** Fresh opaque ids of one synthetic world (to name approved synthetic records before provisioning). */
export function worldIds(): World {
  return {
    client: opaque("sub"),
    otherClient: opaque("sub"),
    provider: opaque("prv"),
    otherProvider: opaque("prv"),
    practice: opaque("prc"),
    appointment: opaque("apt"),
    otherAppointment: opaque("apt"),
    slots: [opaque("slt"), opaque("slt"), opaque("slt"), opaque("slt")],
    otherProviderSlot: opaque("slt"),
    invoice: opaque("inv"),
    paidInvoice: opaque("inv"),
    claim: opaque("clm"),
    referral: opaque("ref"),
    authorization: opaque("aut"),
  };
}

/** Seeds one synthetic world in the tenant's account (display names are role labels, not people). */
export async function seedWorld(t: Tenant, tz = "America/Chicago", ids: World = worldIds()): Promise<World> {
  const w = ids;
  await t.admin.seed(t.accountId, {
    subjects: [w.client, w.otherClient],
    providers: [
      { providerId: w.provider, displayName: "Clinician A", practiceId: w.practice },
      { providerId: w.otherProvider, displayName: "Clinician B", practiceId: null },
    ],
    slots: [
      ...w.slots.map((slotId, i) => ({ slotId, providerId: w.provider, startsAt: inDays(2 + i), timeZone: tz, modality: "video" })),
      { slotId: w.otherProviderSlot, providerId: w.otherProvider, startsAt: inDays(3, 17), timeZone: tz, modality: "in_person" },
    ],
    appointments: [
      { appointmentId: w.appointment, subjectId: w.client, providerId: w.provider, slotId: null, startsAt: inDays(1), timeZone: tz, modality: "video", status: "SCHEDULED", version: 3, visitReason: "synthetic restricted text" },
      { appointmentId: w.otherAppointment, subjectId: w.otherClient, providerId: w.provider, slotId: null, startsAt: inDays(1, 18), timeZone: tz, modality: "phone", status: "SCHEDULED", version: 1 },
    ],
    invoices: [
      {
        invoiceId: w.invoice,
        subjectId: w.client,
        issuedOn: day(-10),
        dueOn: day(20),
        status: "OPEN",
        balanceMinor: 12_500,
        version: 2,
        lines: [{ lineId: opaque("lin"), code: "SESSION_FEE", serviceDate: day(-12), amountMinor: 12_500 }],
        payments: [],
      },
      {
        invoiceId: w.paidInvoice,
        subjectId: w.client,
        issuedOn: day(-40),
        dueOn: day(-10),
        status: "PAID",
        balanceMinor: 0,
        version: 4,
        lines: [{ lineId: opaque("lin"), code: "SESSION_FEE", serviceDate: day(-42), amountMinor: 9_000 }],
        payments: [{ paymentId: opaque("pay"), amountMinor: 9_000, receivedAt: inDays(-15), method: "CARD", cardLast4: "4242" }],
      },
    ],
    claims: [{ claimId: w.claim, subjectId: w.client, serviceDate: day(-12), payerDisplayName: "Synthetic Payer", insurerStatus: "IN_PROCESS", statusAsOf: inDays(-1), diagnosisCodes: "SYNTH-RESTRICTED" }],
    onboarding: [
      {
        providerId: w.provider,
        stage: "DOCUMENTS_PENDING",
        asOf: inDays(-2),
        organizationId: null,
        documents: [
          { documentType: "LICENSE", status: "ACCEPTED", updatedAt: inDays(-30) },
          { documentType: "W9", status: "MISSING", updatedAt: inDays(-3) },
          { documentType: "MALPRACTICE_INSURANCE", status: "EXPIRED", updatedAt: inDays(-3) },
        ],
      },
    ],
    remittances: [0, 1, 2].map((i) => ({
      remittanceId: opaque("rem"),
      practiceId: w.practice,
      periodStart: day(-30 * (i + 1)),
      periodEnd: day(-30 * i - 1),
      totalMinor: 100_000 + i,
      status: i === 0 ? "SCHEDULED" : "SENT",
      paidOn: i === 0 ? null : day(-30 * i),
      bankAccountLast4: "6789",
    })),
    referrals: [{ referralId: w.referral, subjectId: w.client, specialtyCode: "BEHAVIORAL_HEALTH", status: "IN_REVIEW", statusAsOf: inDays(-1), receivedOn: day(-5), referringOrganizationId: null, clinicalSummary: "synthetic restricted text" }],
    authorizations: [{ authorizationId: w.authorization, subjectId: w.client, payerDisplayName: "Synthetic Payer", serviceCode: "SVC_THERAPY", status: "APPROVED", unitsApproved: 12, unitsUsed: 3, validFrom: day(-30), validTo: day(60), statusAsOf: inDays(-2) }],
    eligibility: [{ subjectId: w.client, payerDisplayName: "Synthetic Payer", coverageStatus: "ACTIVE", verifiedAt: inDays(-1), memberReference: "SYNTH-RESTRICTED" }],
  });
  return w;
}

// ------------------------------------------------------------------ ledger helpers (the production action executor)

export const POLICY_VERSION = "policy-2026-10-21.1";

const integration = (tenantId: string, channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({
  integrationId: "it-contact-center",
  tenantId,
  environment: "ci",
  channel,
  credentialId: `cred-${channel.replace(/_/g, "-")}`,
  authMethod: "oauth2_client_credentials",
});

/** A SYNTHETIC verified session (A2) of `subjectId` in `role`, valid for 15 minutes. */
export function sessionOf(tenantId: string, subjectId: string, role: "client" | "provider", clock: Clock = systemClock): AuthContext {
  const now = clock.now();
  return {
    tenantId,
    callId: newId("call"),
    sessionRef: newSessionRef(),
    sessionGeneration: 1,
    actorId: subjectId,
    selectedRole: role,
    subjectId,
    organizationId: null,
    delegatedAuthority: [],
    permittedScopes: ["appointment:read", "appointment:write", "billing:read", "billing:write"],
    assurance: "A2",
    authenticatedAt: iso(now),
    expiresAt: iso(addMs(now, 15 * 60_000)),
    verificationMethod: "secure_link_oidc",
    consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-v1", capturedAt: iso(now), capturedBy: "studio_flow" },
    riskFlags: [],
    policyVersion: POLICY_VERSION,
    revoked: false,
    stepUp: null,
    integration: integration(tenantId, "mcp_tools"),
  };
}

export const allowDecision = (clock: Clock = systemClock): PolicyDecision => ({
  decisionId: newId("pdc"),
  allow: true,
  reasonCodes: ["ALLOW_SELF_SERVICE"],
  fieldMask: [],
  obligations: ["REQUIRE_CONFIRMATION"],
  policyVersion: POLICY_VERSION,
  evaluatedAt: iso(clock.now()),
});

/** The trusted deterministic confirmation (DTMF over the telephony-control identity) of a prepared action. */
export function dtmfConfirmation(ctx: AuthContext, action: { actionId: string; digest: string; sessionGeneration: number }, clock: Clock = systemClock): { confirmation: ActionConfirmation; integration: IntegrationIdentity } {
  return {
    confirmation: {
      actionId: action.actionId,
      digest: action.digest,
      sessionRef: ctx.sessionRef,
      sessionGeneration: action.sessionGeneration,
      turnId: newTurnId(),
      method: "dtmf_keypress",
      capturedBy: "studio-confirm-skill",
      capturedAt: iso(clock.now()),
    },
    integration: integration(ctx.tenantId, "telephony_control"),
  };
}

/** Polls `fn` until it returns true or `timeoutMs` passes. */
export async function eventually(fn: () => Promise<boolean>, timeoutMs = 10_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("EVENTUALLY_TIMEOUT");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
