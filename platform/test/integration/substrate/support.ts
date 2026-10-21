/**
 * Layer-2 support for the substrate suite (WP-04): PostgreSQL databases provisioned the way Aurora is.
 *
 * `createAuroraLikeDb` creates, on the shared postgres:16 service, a database OWNED BY A NON-SUPERUSER
 * migration role (LOGIN CREATEROLE, like the Aurora master user that is not rds_superuser for the
 * application database), pre-creates the pgvector extension as the administrator (an operator step on
 * Aurora), applies every production migration through PgPoolDb as that migration role, and opens a
 * separate APPLICATION login (member of the runtime roles) that serves traffic through
 * `set local role <runtime role>` — never as the owner. `login(roles)` opens a further, SEPARATE login
 * granted exactly `roles` (the audit verifier's own login, for example). Names are unique per call; `drop`
 * removes the database and every login role. Creation is serialized with the same advisory lock as the
 * harness (the foundation migration creates cluster-wide roles).
 *
 * `sinkClient(l2, policy)` returns an S3 client on MinIO with temporary credentials restricted by an inline
 * SESSION POLICY (STS AssumeRole, enforced by MinIO): the exporter's writer and the verifier's reader are
 * different identities with different permissions, as their task roles are in AWS.
 */
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { assumeRoleWithSessionPolicy } from "../../../src/audit/exporter/sts.js";
import type { StsHttpPost } from "../../../src/audit/exporter/sts.js";
import { LOCAL_STS_HOST } from "../../../src/audit/exporter/verify-cli.js";
import { ConnectorHttpTransport } from "../../../src/connectors/http/index.js";
import { migrate } from "../../../src/db/migrate.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { PgPoolOptions } from "../../../src/db/pg.js";
import { REGION, SYNTHETIC_ACCOUNT, postgresUrl } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import type { Layer2Context } from "../_harness/layer2.js";

export const RUNTIME_ROLES = ["app_runtime", "app_worker", "app_console", "app_auditor", "app_audit_verifier"] as const;

export interface AuroraLikeDb {
  name: string;
  /** Application login (member of the runtime roles; not the owner). */
  db: PgPoolDb;
  /** Migration login (database owner, non-superuser). */
  migrator: PgPoolDb;
  migratorRole: string;
  appRole: string;
  appUrl: string;
  /** Opens another pool of the application login (a second process or replica). */
  pool(max?: number, opts?: Omit<PgPoolOptions, "max">): PgPoolDb;
  /** A separate login granted exactly `roles`, with its own pool (dropped by `drop`). */
  login(roles: readonly (typeof RUNTIME_ROLES)[number][], max?: number): Promise<{ name: string; db: PgPoolDb; url: string }>;
  drop(): Promise<void>;
}

const urlFor = (l2: Layer2Context, role: string, password: string, database: string) =>
  `postgres://${role}:${password}@127.0.0.1:${l2.port("postgres", 5432)}/${database}`;

export async function createAuroraLikeDb(l2: Layer2Context, opts: { poolSize?: number; pgvector?: boolean } = {}): Promise<AuroraLikeDb> {
  const id = randomBytes(5).toString("hex");
  const name = `vsp_sub_${id}`;
  const migratorRole = `vsp_mig_${id}`;
  const appRole = `vsp_app_${id}`;
  const migPw = randomBytes(16).toString("hex");
  const appPw = randomBytes(16).toString("hex");
  const admin = PgPoolDb.fromConnectionString(postgresUrl(l2), 2);
  const pools: PgPoolDb[] = [];
  try {
    await admin.exec(`create role ${migratorRole} login createrole password '${migPw}'`);
    await admin.exec(`create role ${appRole} login password '${appPw}'`);
    await admin.exec(`create database ${name} owner ${migratorRole}`);
    if (opts.pgvector !== false) {
      const inDb = PgPoolDb.fromConnectionString(postgresUrl(l2, name), 1);
      try {
        await inDb.exec("create extension if not exists vector");
      } finally {
        await inDb.close();
      }
    }
    const migrator = PgPoolDb.fromConnectionString(urlFor(l2, migratorRole, migPw, name), 2);
    pools.push(migrator);
    await admin.tx(
      async (tx) => {
        await tx.query("select pg_advisory_xact_lock(7300004)");
        await migrate(migrator);
        // The platform operator grants the runtime roles to the application login (IAM login role on Aurora).
        await tx.query(`grant ${RUNTIME_ROLES.join(", ")} to ${appRole}`);
      },
      { role: "owner" },
    );
    const appUrl = urlFor(l2, appRole, appPw, name);
    const db = PgPoolDb.fromConnectionString(appUrl, opts.poolSize ?? 8, { applicationName: "vsp-substrate-it" });
    pools.push(db);
    const extraLogins: string[] = [];
    return {
      name,
      db,
      migrator,
      migratorRole,
      appRole,
      appUrl,
      pool: (max = 4, o = {}) => {
        const p = PgPoolDb.fromConnectionString(appUrl, max, { applicationName: "vsp-substrate-it", ...o });
        pools.push(p);
        return p;
      },
      async login(roles, max = 2) {
        for (const r of roles) if (!(RUNTIME_ROLES as readonly string[]).includes(r)) throw new Error(`unknown runtime role ${r}`);
        const role = `vsp_login_${randomBytes(5).toString("hex")}`;
        const pw = randomBytes(16).toString("hex");
        const a = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
        try {
          await a.exec(`create role ${role} login password '${pw}'`);
          extraLogins.push(role);
          if (roles.length > 0) await a.exec(`grant ${roles.join(", ")} to ${role}`);
        } finally {
          await a.close();
        }
        const url = urlFor(l2, role, pw, name);
        const p = PgPoolDb.fromConnectionString(url, max, { applicationName: "vsp-substrate-it-login" });
        pools.push(p);
        return { name: role, db: p, url };
      },
      async drop() {
        for (const p of pools) await p.close().catch(() => undefined);
        const a = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
        try {
          await a.exec(`drop database if exists ${name} with (force)`);
          for (const r of [...extraLogins, appRole, migratorRole]) {
            await a.exec(`drop owned by ${r}`).catch(() => undefined);
            await a.exec(`drop role if exists ${r}`).catch(() => undefined);
          }
        } finally {
          await a.close();
        }
      },
    };
  } catch (err) {
    for (const p of pools) await p.close().catch(() => undefined);
    await admin.exec(`drop database if exists ${name} with (force)`).catch(() => undefined);
    for (const r of [appRole, migratorRole]) await admin.exec(`drop role if exists ${r}`).catch(() => undefined);
    throw err;
  } finally {
    await admin.close();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * An S3 client on MinIO whose temporary credentials are restricted by `policy` (STS AssumeRole with an
 * inline session policy, derived from the emulator administrator — the local stand-in for a task role).
 */
/** The production egress-classified transport with one loopback route: LOCAL_STS_HOST -> MinIO (STS API). */
export function localStsHttp(l2: Layer2Context): StsHttpPost {
  const transport = new ConnectorHttpTransport({
    environment: "local",
    egress: {
      assertAllowed(target: URL) {
        if (target.hostname !== LOCAL_STS_HOST) throw new Error("EGRESS_DESTINATION_NOT_ALLOWED");
      },
    },
    loopbackRoutes: new Map([[LOCAL_STS_HOST, { port: l2.port("minio", 9000), tls: false }]]),
  });
  return {
    async post(url, headers, body) {
      const r = await transport.send({
        method: "POST",
        url,
        headers,
        body,
        policy: { allowedHosts: [LOCAL_STS_HOST], addressClass: "PRIVATE_NETWORK", dataClass: "INTERNAL" },
        sideEffect: false,
        timeoutMs: 10_000,
        dependency: "audit_sts",
      });
      return { status: r.status, body: r.body.toString("utf8") };
    },
  };
}

export async function sinkClient(l2: Layer2Context, policy: Record<string, unknown>, sessionName: string): Promise<S3Client> {
  const env = localEnv();
  const endpoint = l2.url("minio", 9000);
  const creds = await assumeRoleWithSessionPolicy(
    {
      endpoint: `https://${LOCAL_STS_HOST}/`,
      region: REGION,
      credentials: { accessKeyId: env.minioUser, secretAccessKey: env.minioPassword },
      roleArn: `arn:aws:iam::${SYNTHETIC_ACCOUNT}:role/${sessionName}`,
      sessionName,
      policy,
    },
    localStsHttp(l2),
  );
  return new S3Client({ region: REGION, endpoint, forcePathStyle: true, credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken } });
}

/** A one-shot latch for ordering two concurrent transactions deterministically. */
export function latch(): { promise: Promise<void>; release: () => void } {
  let release = () => undefined as void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
