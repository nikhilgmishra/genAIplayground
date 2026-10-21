/**
 * Building blocks of the live composition, Docker-free (WP-07; DATA-01, AUTH-02, OPS-04, OPS-APPR-01):
 *  - PostgreSQL TLS: outside sandbox every live unit's connection verifies the server certificate and host name
 *    (sslmode=verify-full), for the RDS/Aurora JSON secret and for a URI; anything weaker is refused before a
 *    pool exists. The parsed result is checked with the driver itself (pg.Client connection parameters).
 *  - the connector credential sets handed to the guard: this environment's profiles and adapter references
 *    plus every other committed environment's adapter references; the other environments' signing keys (key
 *    separation, FO-14-56);
 *  - the served artifacts every unit hands to the guard (policy bundle, catalogue, templates, image digest).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPlatformConfig } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import { createMemoryLogger } from "../observability/logger.js";
import { ensurePolicyBundle } from "../policy/ensure-bundle.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { committedCatalogDigest, committedConfigFiles, committedSigningKeySets, connectorCredentialSets, pgConnectionString, servedArtifacts } from "./live-modules.js";

const violations = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigurationRejectedError) return e.violations;
    throw e;
  }
  return [];
};
/** The TLS options the pg driver derives from a connection string (false: plaintext). */
const driverSsl = (cs: string): unknown => (new pg.Client({ connectionString: cs }) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
const json = (o: Record<string, unknown>) => JSON.stringify({ engine: "postgres", host: "vsp.cluster-synthetic.us-east-1.rds.amazonaws.com", port: 5432, username: "vsp_runtime", password: "pw_synthOnlyForTests", dbname: "vsp", ...o });

describe("pgConnectionString: TLS outside sandbox [DATA-01]", () => {
  it("[DATA-01] positive: a JSON secret without sslmode gets verify-full (the driver verifies certificate and host); sslrootcert names the CA bundle file", () => {
    for (const environment of ["staging", "production"] as const) {
      const cs = pgConnectionString(json({}), { environment });
      expect(new URL(cs).searchParams.get("sslmode")).toBe("verify-full");
      expect(driverSsl(cs)).toEqual({});
      const withCa = pgConnectionString(json({ sslmode: "verify-full", sslrootcert: "/etc/ssl/certs/rds-global-bundle.pem" }), { environment });
      expect(new URL(withCa).searchParams.get("sslrootcert")).toBe("/etc/ssl/certs/rds-global-bundle.pem");
      expect(pgConnectionString("postgres://u:p@db.internal.example.com:5432/vsp?sslmode=verify-full", { environment })).toContain("sslmode=verify-full");
    }
  });

  it("[DATA-01] adversarial: outside sandbox sslmode disable / allow / prefer / require / verify-ca, a URI without sslmode, a duplicated sslmode or the legacy ssl parameter are refused DATABASE_TLS_REQUIRED (path only, never the secret)", () => {
    for (const environment of ["staging", "production"] as const) {
      for (const mode of ["disable", "allow", "prefer", "require", "verify-ca"]) {
        expect(violations(() => pgConnectionString(json({ sslmode: mode }), { environment })), mode).toEqual(["DATABASE_TLS_REQUIRED@database.connectionRef"]);
      }
      for (const uri of [
        "postgres://u:p@db.internal.example.com:5432/vsp",
        "postgres://u:p@db.internal.example.com:5432/vsp?sslmode=disable",
        "postgresql://u:p@db.internal.example.com:5432/vsp?sslmode=require",
        "postgres://u:p@db.internal.example.com:5432/vsp?sslmode=verify-full&ssl=false",
        "postgres://u:p@db.internal.example.com:5432/vsp?sslmode=verify-full&sslmode=disable",
      ]) {
        const v = violations(() => pgConnectionString(uri, { environment, path: "infrastructure.auditExport.exporterDatabaseRef" }));
        expect(v, uri).toEqual(["DATABASE_TLS_REQUIRED@infrastructure.auditExport.exporterDatabaseRef"]);
        expect(v.join(" ")).not.toContain("u:p");
      }
    }
    // Probe of the defect: without the rule, these strings reach the driver as plaintext connections.
    expect(driverSsl("postgres://u:p@db.internal.example.com:5432/vsp")).toBe(false);
  });

  it("[DATA-01] adversarial: outside sandbox a URI secret may carry only sslmode and sslrootcert; parameters or hosts that redirect the connection (socket path, hostaddr, libpq compat, client keys) are refused", () => {
    const base = "postgres://u:p@db.example.com:5432/vsp?sslmode=verify-full";
    for (const environment of ["staging", "production"] as const) {
      // Every case below was ACCEPTED before this rule (verifier probe pgtls.mts); pg then connected without TLS
      // to a unix socket, or with weakened verification.
      for (const uri of [
        `${base}&host=/var/run/postgresql`,
        `${base}&hostaddr=10.0.0.9`,
        `${base}&uselibpqcompat=true`,
        `${base}&sslcert=/etc/ssl/client.pem`,
        `${base}&sslkey=/etc/ssl/client.key`,
        `${base}&sslnegotiation=direct`,
        `${base}&options=-c%20search_path%3Devil`,
        `${base}&port=6543`,
        `${base}&user=other`,
        `${base}&sslrootcert=/dev/null`,
        `${base}&sslrootcert=/etc/ssl/a.pem&sslrootcert=/etc/ssl/b.pem`,
        `${base}&sslrootcert=../ca.pem`,
      ]) {
        expect(violations(() => pgConnectionString(uri, { environment })), uri).toEqual(["DATABASE_TLS_REQUIRED@database.connectionRef"]);
      }
      for (const uri of [
        "postgres://u:p@/vsp?host=/tmp&sslmode=verify-full",
        "postgres://u:p@%2Fvar%2Frun%2Fpostgresql/vsp?sslmode=verify-full",
        "postgres://u:p@db.example.com:5432/vsp/extra?sslmode=verify-full",
        "postgres://u:p@db.example.com:5432/vsp%3Fhost%3D%2Ftmp?sslmode=verify-full",
        "postgres://u:p@db.example.com:5432/?sslmode=verify-full",
        "postgres://u:p@db.example.com:5432/vsp?sslmode=verify-full#frag",
      ]) {
        const v = violations(() => pgConnectionString(uri, { environment }));
        expect(v.length, uri).toBe(1);
        expect(v[0], uri).toMatch(/^DATABASE_(SECRET_MALFORMED|TLS_REQUIRED)@database\.connectionRef$/);
      }
      // JSON form: a database name that tries to smuggle parameters is malformed.
      expect(violations(() => pgConnectionString(json({ dbname: "vsp?host=/tmp" }), { environment }))).toEqual(["DATABASE_SECRET_MALFORMED@database.connectionRef"]);
    }
    // What the driver makes of an accepted secret: the URI host, TLS on, no socket, no other parameter.
    const params = (cs: string) => (new pg.Client({ connectionString: cs }) as unknown as { connectionParameters: { host: string; ssl: unknown; port: number } }).connectionParameters;
    // The driver reads the CA bundle while parsing: a scratch file stands in for the image's bundle.
    const caDir = mkdtempSync(join(tmpdir(), "vsp-live-modules-ca-"));
    const caFile = join(caDir, "ca-bundle.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");
    try {
      for (const cs of [base, `${base}&sslrootcert=${caFile}`, pgConnectionString(json({}), { environment: "production" })]) {
        const accepted = pgConnectionString(cs, { environment: "production" });
        const p = params(accepted);
        expect(p.host, cs).toBe(new URL(accepted).hostname);
        expect(p.host.startsWith("/"), cs).toBe(false);
        expect(p.ssl, cs).not.toBe(false);
      }
    } finally {
      rmSync(caDir, { recursive: true, force: true });
    }
    // Probe of the defect: the same driver honours the injected host (a unix socket) and drops TLS.
    expect(params(`${base}&host=/var/run/postgresql`).host).toBe("/var/run/postgresql");
  });

  it("[DATA-01] sandbox may run an emulator without TLS; malformed secrets are refused in every environment", () => {
    expect(driverSsl(pgConnectionString("postgres://u:p@localhost:5432/vsp", { environment: "sandbox" }))).toBe(false);
    expect(driverSsl(pgConnectionString(json({ sslmode: "disable" }), { environment: "sandbox" }))).toBe(false);
    expect(new URL(pgConnectionString(json({}), { environment: "sandbox" })).searchParams.get("sslmode")).toBe("verify-full");
    for (const bad of ["not json", json({ host: "bad host" }), json({ sslmode: "insecure" }), json({ sslrootcert: "../../etc/passwd" }), json({ sslrootcert: "relative.pem" })]) {
      expect(violations(() => pgConnectionString(bad, { environment: "production" })), bad.slice(0, 40)).toEqual(["DATABASE_SECRET_MALFORMED@database.connectionRef"]);
    }
  });
});

describe("guard inputs shared by every live unit [AUTH-02][OPS-04]", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "vsp-live-modules-"));
    dirs.push(d);
    return d;
  };

  it("[AUTH-02][FO-05-56] the credential sets carry this environment's adapter references and every OTHER committed environment's, never this environment twice", () => {
    const configDir = scratch();
    writeFileSync(join(configDir, "staging.json"), JSON.stringify({ environment: "staging", adapters: { salesforce: { credentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-staging-sf" } } }));
    writeFileSync(join(configDir, "sandbox.json"), JSON.stringify({ environment: "sandbox", adapters: { salesforce: { credentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:stale-file-value" } } }));
    const preliminary = { adapters: { salesforce: { kind: "live", credentialRef: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-sandbox-sf" } }, connectors: undefined } as unknown as PlatformConfig;
    const { sets, profiles } = connectorCredentialSets(preliminary, { environment: "sandbox", configDir });
    expect(profiles).toEqual([]);
    expect(sets).toEqual([
      { environment: "sandbox", profiles: [], adapterCredentialRefs: { salesforce: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-sandbox-sf" } },
      { environment: "staging", profiles: [], adapterCredentialRefs: { salesforce: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-staging-sf" } },
    ]);
  });

  it("[AUTH-02] a profile directory that does not load refuses the unit (CONNECTOR_PROFILE_REJECTED@connectors.profileDirectory), before the guard", () => {
    const repoRoot = scratch();
    mkdirSync(join(repoRoot, "connectors"));
    writeFileSync(join(repoRoot, "connectors", "broken.json"), "{ not json");
    const preliminary = { adapters: {}, connectors: { profileDirectory: "connectors", feeds: [] } } as unknown as PlatformConfig;
    expect(violations(() => connectorCredentialSets(preliminary, { environment: "sandbox", configDir: scratch(), repoRoot }))).toEqual(["CONNECTOR_PROFILE_REJECTED@connectors.profileDirectory", "PROFILE_NOT_JSON@connectors.profileDirectory"]);
    expect(violations(() => connectorCredentialSets({ ...preliminary, connectors: { profileDirectory: "missing", feeds: [] } } as unknown as PlatformConfig, { environment: "sandbox", configDir: scratch(), repoRoot }))).toEqual(["CONNECTOR_PROFILE_REJECTED@connectors.profileDirectory"]);
  });

  it("[FO-14-56][AUTH-02] the key sets carry every OTHER committed environment's assertion and audit manifest keys, approval trust anchor and secrets (never this environment's file); an unreadable directory refuses the unit", () => {
    const configDir = scratch();
    const k = (n: number) => `arn:aws:kms:us-east-1:111122223333:key/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
    const sec = (name: string) => `arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-staging-${name}`;
    writeFileSync(
      join(configDir, "staging.json"),
      JSON.stringify({
        environment: "staging",
        signing: { assertionKeyRef: k(1) },
        approvals: { trustedSigningKeyRef: k(6) },
        database: { connectionRef: sec("aurora") },
        adapters: { scheduling: { credentialRef: sec("scheduling") }, billing: { credentialRef: null } },
        infrastructure: {
          auditExport: { manifestSigningKeyId: k(2), trustedManifestKeyIds: [k(2), k(3), 7], exporterDatabaseRef: sec("exporter"), verifierDatabaseRef: sec("verifier") },
          secrets: { requestHashPepperRef: sec("pepper"), otpPepperRef: 12, consoleSessionSealerRef: sec("sealer") },
        },
      }),
    );
    writeFileSync(join(configDir, "production.json"), JSON.stringify({ environment: "production", signing: { assertionKeyRef: k(4) } }));
    writeFileSync(join(configDir, "sandbox.json"), JSON.stringify({ environment: "sandbox", signing: { assertionKeyRef: k(5) }, approvals: { trustedSigningKeyRef: k(7) } }));
    writeFileSync(join(configDir, "notes.txt"), "not a configuration");
    expect(committedSigningKeySets({ environment: "sandbox", configDir })).toEqual([
      { environment: "production", assertionKeyRef: k(4), manifestSigningKeyId: null, trustedManifestKeyIds: [], approvalTrustKeyRef: null, secrets: [] },
      {
        environment: "staging",
        assertionKeyRef: k(1),
        manifestSigningKeyId: k(2),
        trustedManifestKeyIds: [k(2), k(3)],
        approvalTrustKeyRef: k(6),
        // Strings only (a number is not a reference); the purposes the separation rule compares.
        secrets: [
          { ref: sec("aurora"), path: "database.connectionRef", purpose: "database-login" },
          { ref: sec("pepper"), path: "infrastructure.secrets.requestHashPepperRef", purpose: "request-hash-pepper" },
          { ref: sec("sealer"), path: "infrastructure.secrets.consoleSessionSealerRef", purpose: "console-session-sealer" },
          { ref: sec("exporter"), path: "infrastructure.auditExport.exporterDatabaseRef", purpose: "audit-exporter-login" },
          { ref: sec("verifier"), path: "infrastructure.auditExport.verifierDatabaseRef", purpose: "audit-verifier-login" },
          { ref: sec("scheduling"), path: "adapters.scheduling.credentialRef", purpose: "adapter:scheduling" },
        ],
      },
    ]);
    // The committed repository configuration is readable and never lists the asking environment.
    expect(committedSigningKeySets({ environment: "production" }).map((e) => e.environment)).not.toContain("production");
    writeFileSync(join(configDir, "broken.json"), "{ not json");
    expect(violations(() => committedSigningKeySets({ environment: "sandbox", configDir }))).toEqual(["COMMITTED_CONFIG_UNREADABLE@configDir.broken"]);
    expect(violations(() => committedSigningKeySets({ environment: "sandbox", configDir: join(configDir, "missing") }))).toEqual(["COMMITTED_CONFIG_UNREADABLE@configDir"]);
  });

  it("[FO-14-56][AUTH-02][OPS-04] fail closed: a committed configuration whose environment does not parse, a file named after another environment than it declares, or a non-object file refuses the unit (COMMITTED_CONFIG_UNREADABLE@configDir.<name>) in BOTH cross-environment readers; it never drops out of the checks", () => {
    const k = (n: number) => `arn:aws:kms:us-east-1:111122223333:key/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
    const preliminary = { adapters: {}, connectors: undefined } as unknown as PlatformConfig;
    const both = (configDir: string) => [violations(() => committedSigningKeySets({ environment: "sandbox", configDir })), violations(() => connectorCredentialSets(preliminary, { environment: "sandbox", configDir }))];
    const cases: [string, string, unknown][] = [
      // A sibling holding the sandbox anchor as its assertion key, with an environment that does not parse: it would
      // have dropped out of the separation checks.
      ["environment does not parse", "staging", { environment: "stagging", signing: { assertionKeyRef: k(7) } }],
      ["no environment", "production", { signing: { assertionKeyRef: k(7) } }],
      // staging.json declaring sandbox would be skipped as the sandbox's own file (and the loader refuses it for staging).
      ["file named after another environment", "staging", { environment: "sandbox", signing: { assertionKeyRef: k(7) } }],
      ["not an object", "production", ["production"]],
    ];
    for (const [label, name, doc] of cases) {
      const configDir = scratch();
      writeFileSync(join(configDir, "sandbox.json"), JSON.stringify({ environment: "sandbox" }));
      writeFileSync(join(configDir, `${name}.json`), JSON.stringify(doc));
      expect(both(configDir), label).toEqual([[`COMMITTED_CONFIG_UNREADABLE@configDir.${name}`], [`COMMITTED_CONFIG_UNREADABLE@configDir.${name}`]]);
    }
    // Every refused file is named (reason codes and file names only, never values).
    const configDir = scratch();
    writeFileSync(join(configDir, "staging.json"), JSON.stringify({ environment: 7 }));
    writeFileSync(join(configDir, "production.json"), "{ not json");
    expect(violations(() => committedSigningKeySets({ environment: "sandbox", configDir }))).toEqual(["COMMITTED_CONFIG_UNREADABLE@configDir.production", "COMMITTED_CONFIG_UNREADABLE@configDir.staging"]);
    // Control: a file with a non-environment name that declares a valid environment is read (and compared).
    const ok = scratch();
    writeFileSync(join(ok, "extra.json"), JSON.stringify({ environment: "staging", signing: { assertionKeyRef: k(7) } }));
    expect(committedSigningKeySets({ environment: "sandbox", configDir: ok }).map((e) => [e.environment, e.assertionKeyRef])).toEqual([["staging", k(7)]]);
    expect(committedConfigFiles(ok).map((f) => f.name)).toEqual(["extra"]);
  });

  describe("served artifacts", () => {
    beforeAll(() => ensurePolicyBundle());
    it("[OPS-04][OPS-APPR-01] every unit hands the guard the loaded policy bundle, the committed catalogue digest, the template catalogue digest and the image digest", async () => {
      const preliminary = loadPlatformConfig({ environment: "production", env: {} }).config;
      const { logger } = createMemoryLogger();
      const digest = `sha256:${"e".repeat(64)}`;
      const a = await servedArtifacts({ ...preliminary, policy: { ...preliminary.policy, expectedVersion: null, expectedDigest: null } }, { environment: "production", clock: new FakeClock(), logger, releaseImageDigest: digest });
      expect(a.policy).not.toBeNull();
      expect(a.loadedPolicy).toEqual({ version: a.policy?.policyVersion, digest: a.policy?.bundleDigest });
      expect(a.toolCatalogDigest).toBe(committedCatalogDigest());
      expect(a.toolCatalogDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(a.templateCatalogDigest).toBe(a.templates.digest());
      expect(a.templateCatalogDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(a.releaseImageDigest).toBe(digest);
      // A pinned digest that is not the bundle's: the bundle does not load (the guard then refuses POLICY_BUNDLE_NOT_LOADED).
      const wrong = await servedArtifacts({ ...preliminary, policy: { ...preliminary.policy, expectedDigest: "0".repeat(64) } }, { environment: "production", clock: new FakeClock(), logger, releaseImageDigest: null });
      expect([wrong.policy, wrong.loadedPolicy]).toEqual([null, null]);
    });
  });
});
