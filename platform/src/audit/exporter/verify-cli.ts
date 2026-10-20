/**
 * Implementation of scripts/vsp/verify-audit.mts (kept in the platform so it resolves the platform's
 * dependencies). `verify-audit`: the separate audit verifier as a command (follow-on FO-19-82, FO-15-40, FO-22-08).
 *
 *   tsx scripts/vsp/verify-audit.mts --env local --database <name> [--bucket <name>] [--kms-key <key-id>]
 *                                    [--from <ISO>] [--to <ISO>] [--prefix audit/] [--json <file>]
 *   tsx scripts/vsp/verify-audit.mts --env live  (needs VSP_AUDIT_VERIFY_LIVE=1, see below)
 *
 * Verifies the audit hash chains, the independent sink copy, manifest signatures and the completeness
 * reconciliation for a time range with platform/src/audit/exporter/verifier.ts, under the verifier's OWN
 * database login (granted app_audit_verifier only; every transaction runs `set local role
 * app_audit_verifier`) and the sink READER credentials (list + get only). The verifier refuses a verdict
 * when its login is a superuser, owns objects, belongs to a writer role or can write (checkIdentity).
 * Prints a content-free JSON report (codes, streams, sequences, opaque ids, counts).
 *
 * Exit codes: 0 PASS; 1 FAIL (findings); 2 INCONCLUSIVE (no sink reader, no signature key, never a pass);
 * 3 usage or configuration error; 4 a dependency (database, sink, KMS) could not be reached.
 *
 * --env local: the Layer-2 composition (make up PROFILE=core). PostgreSQL, MinIO and LocalStack on
 *   127.0.0.1 at their published ports (VSP_PORT_POSTGRES / VSP_PORT_MINIO / VSP_PORT_LOCALSTACK override
 *   55432 / 59000 / 54566) with the generated emulator credentials of .tools/vsp-local/env
 *   (VSP_LOCAL_STATE_DIR overrides). Synthetic data only. The emulator administrator is used ONLY to
 *   provision the run's identities, the local equivalent of the operator's IAM/login provisioning: a
 *   per-run database login `vsp_verify_<random>` granted app_audit_verifier only (dropped afterwards), and
 *   MinIO session credentials restricted by an inline read-only session policy on the bucket (STS
 *   AssumeRole, enforced by MinIO). The verification itself runs on those identities alone.
 * --env live: reads production audit evidence, so it never runs from a default command. It requires
 *   VSP_AUDIT_VERIFY_LIVE=1 plus VSP_AUDIT_VERIFIER_DATABASE_URL (the verifier's own login role),
 *   VSP_AUDIT_BUCKET, VSP_AUDIT_BUCKET_OWNER, VSP_AUDIT_KMS_KEY_ID and AWS_REGION; AWS credentials come
 *   from the default provider chain (the verifier task role: s3 list/get on the audit bucket and
 *   kms:GetPublicKey only). Activation: AIN-03.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { PgPoolDb } from "../../db/pg.js";
import type { Queryable } from "../../db/types.js";
import { systemClock } from "../../shared/clock.js";
import { S3ObjectLockAuditSink } from "../sinks/s3-object-lock.js";
import { ManifestSignatureVerifier } from "./signer.js";
import { assumeRoleWithSessionPolicy, sinkReaderPolicy } from "./sts.js";
import type { StsHttpPost } from "./sts.js";
import { AuditExportVerifier } from "./verifier.js";
import type { AuditVerificationReport } from "./verifier.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const REGION_LOCAL = "us-east-1";
const SYNTHETIC_ACCOUNT = "123456789012";

export const EXIT = { pass: 0, fail: 1, inconclusive: 2, usage: 3, dependency: 4 } as const;

export class UsageError extends Error {}

export interface VerifyAuditArgs {
  env: "local" | "live";
  database: string | null;
  bucket: string | null;
  kmsKey: string | null;
  prefix: string;
  from: string;
  to: string;
  json: string | null;
}

export function parseArgs(argv: readonly string[], now: Date = new Date()): VerifyAuditArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    flags.set(a.slice(2), v);
    i++;
  }
  for (const k of flags.keys()) if (!["env", "database", "bucket", "kms-key", "prefix", "from", "to", "json"].includes(k)) throw new UsageError(`unknown option --${k}`);
  const env = flags.get("env");
  if (env !== "local" && env !== "live") throw new UsageError("--env local|live is required");
  const database = flags.get("database") ?? null;
  if (database !== null && !/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new UsageError("--database must be a plain database name");
  const bucket = flags.get("bucket") ?? null;
  if (bucket !== null && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new UsageError("--bucket is not a valid bucket name");
  const prefix = flags.get("prefix") ?? "audit/";
  if (!/^([a-z0-9_-]{1,32}\/){0,4}$/.test(prefix)) throw new UsageError("--prefix must look like audit/");
  const to = flags.get("to") ?? new Date(now.getTime() + 60_000).toISOString();
  const from = flags.get("from") ?? new Date(now.getTime() - 86_400_000).toISOString();
  for (const t of [from, to]) if (Number.isNaN(Date.parse(t)) || !/^\d{4}-\d{2}-\d{2}T/.test(t)) throw new UsageError("--from/--to must be ISO-8601 instants");
  return { env, database, bucket, kmsKey: flags.get("kms-key") ?? null, prefix, from: new Date(from).toISOString(), to: new Date(to).toISOString(), json: flags.get("json") ?? null };
}

function localState(): Record<string, string> {
  const dir = resolve(process.env.VSP_LOCAL_STATE_DIR ?? join(REPO_ROOT, ".tools", "vsp-local"));
  let text: string;
  try {
    text = readFileSync(join(dir, "env"), "utf8");
  } catch {
    throw new UsageError(`local state missing in ${dir}; run make up PROFILE=core`);
  }
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line === "" || line.startsWith("#") || eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    env[line.slice(0, eq).trim()] = v;
  }
  return env;
}

const port = (name: string, fallback: number): number => {
  const v = Number(process.env[`VSP_PORT_${name}`] ?? fallback);
  if (!Number.isInteger(v) || v < 1 || v > 65_535) throw new UsageError(`VSP_PORT_${name} is not a port`);
  return v;
};

export function exitCodeFor(report: AuditVerificationReport): number {
  return report.verdict === "PASS" ? EXIT.pass : report.verdict === "FAIL" ? EXIT.fail : EXIT.inconclusive;
}

/** Host name of the local emulator's STS endpoint (MinIO), routed to its loopback port by the composition. */
export const LOCAL_STS_HOST = "sts.minio.vsp.local";

/** Where the local STS endpoint listens: the composition's loopback route for LOCAL_STS_HOST. */
export function localStsRoute(): { host: string; port: number } {
  return { host: LOCAL_STS_HOST, port: port("MINIO", 59000) };
}

/**
 * CREATE / COMMENT / DROP ROLE take no bind parameters. The login name and the literal travel as BOUND
 * parameters into transaction-local settings, and a constant DO block expands them with format(%I, %L) and
 * executes the statement server-side, so the SQL text this process sends is always constant.
 */
async function withProvisionArgs(db: PgPoolDb, login: string, literal: string, run: (tx: Queryable) => Promise<unknown>): Promise<void> {
  await db.tx(
    async (tx) => {
      await tx.query("select set_config('vsp.verify_login', $1, true), set_config('vsp.verify_literal', $2, true)", [login, literal]);
      await run(tx);
    },
    { role: "owner" },
  );
}

/** A per-run local verifier login (granted app_audit_verifier only); `drop` removes it. */
async function provisionLocalVerifierLogin(adminUrl: string, database: string, pgPort: number): Promise<{ url: string; drop(): Promise<void> }> {
  const login = `vsp_verify_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  const admin = PgPoolDb.fromConnectionString(adminUrl, 1, { applicationName: "vsp-verify-audit-provision" });
  try {
    const exists = await admin.query<{ ok: boolean }>("select exists (select 1 from pg_roles where rolname = 'app_audit_verifier') as ok");
    if (exists.rows[0]?.ok !== true) throw new UsageError("the database has no app_audit_verifier role (migration 2042 not applied)");
    await withProvisionArgs(admin, login, password, (tx) =>
      tx.query("do $$ begin execute format('create role %I login password %L in role app_audit_verifier', current_setting('vsp.verify_login'), current_setting('vsp.verify_literal')); end $$"),
    );
    await withProvisionArgs(admin, login, `vsp verify-audit local run on database ${database}`, (tx) =>
      tx.query("do $$ begin execute format('comment on role %I is %L', current_setting('vsp.verify_login'), current_setting('vsp.verify_literal')); end $$"),
    );
  } finally {
    await admin.close();
  }
  return {
    url: `postgres://${login}:${password}@127.0.0.1:${pgPort}/${database}`,
    async drop() {
      const a = PgPoolDb.fromConnectionString(adminUrl, 1, { applicationName: "vsp-verify-audit-provision" });
      try {
        await withProvisionArgs(a, login, "", (tx) => tx.query("do $$ begin execute format('drop role if exists %I', current_setting('vsp.verify_login')); end $$"));
      } finally {
        await a.close();
      }
    },
  };
}

export interface VerifyAuditDeps {
  /**
   * HTTPS transport for the local STS call (the egress-classified transport with a loopback route for
   * LOCAL_STS_HOST; scripts/vsp/verify-audit.mts composes it). Required with --env local and --bucket.
   */
  stsHttp?: StsHttpPost;
}

export async function verifyAudit(args: VerifyAuditArgs, deps: VerifyAuditDeps = {}): Promise<AuditVerificationReport> {
  let db: PgPoolDb;
  let s3: S3Client | null = null;
  let kms: KMSClient | null = null;
  let bucketOwner = SYNTHETIC_ACCOUNT;
  let kmsKey = args.kmsKey;
  let bucket = args.bucket;
  let cleanup: (() => Promise<void>) | null = null;
  if (args.env === "local") {
    if (!args.database) throw new UsageError("--database is required with --env local");
    const st = localState();
    const need = (k: string) => {
      const v = st[k];
      if (!v) throw new UsageError(`local state lacks ${k}; run make up PROFILE=core`);
      return v;
    };
    const pgPort = port("POSTGRES", 55432);
    const login = await provisionLocalVerifierLogin(`postgres://vsp:${encodeURIComponent(need("VSP_POSTGRES_PASSWORD"))}@127.0.0.1:${pgPort}/${args.database}`, args.database, pgPort);
    cleanup = () => login.drop();
    db = PgPoolDb.fromConnectionString(login.url, 2, { applicationName: "vsp-verify-audit" });
    if (bucket) {
      if (!deps.stsHttp) throw new UsageError("--bucket with --env local needs the STS transport (run through scripts/vsp/verify-audit.mts)");
      // The verifier never reads the sink with the administrator's keys: STS derives list/get-only session credentials.
      const reader = await assumeRoleWithSessionPolicy(
        {
          endpoint: `https://${LOCAL_STS_HOST}/`,
          region: REGION_LOCAL,
          credentials: { accessKeyId: need("VSP_MINIO_ROOT_USER"), secretAccessKey: need("VSP_MINIO_ROOT_PASSWORD") },
          roleArn: `arn:aws:iam::${SYNTHETIC_ACCOUNT}:role/vsp-audit-verifier-local`,
          sessionName: "vsp-verify-audit",
          policy: sinkReaderPolicy(bucket),
        },
        deps.stsHttp,
      );
      s3 = new S3Client({
        region: REGION_LOCAL,
        endpoint: `http://127.0.0.1:${port("MINIO", 59000)}`,
        forcePathStyle: true,
        credentials: { accessKeyId: reader.accessKeyId, secretAccessKey: reader.secretAccessKey, sessionToken: reader.sessionToken },
      });
    }
    if (kmsKey) {
      kms = new KMSClient({
        region: REGION_LOCAL,
        endpoint: `http://127.0.0.1:${port("LOCALSTACK", 54566)}`,
        credentials: { accessKeyId: need("VSP_AWS_ACCESS_KEY_ID"), secretAccessKey: need("VSP_AWS_SECRET_ACCESS_KEY") },
      });
    }
  } else {
    if (process.env.VSP_AUDIT_VERIFY_LIVE !== "1") throw new UsageError("--env live reads production audit evidence: set VSP_AUDIT_VERIFY_LIVE=1 under a scoped authorization (AIN-03)");
    const url = process.env.VSP_AUDIT_VERIFIER_DATABASE_URL;
    const region = process.env.AWS_REGION;
    bucket = bucket ?? process.env.VSP_AUDIT_BUCKET ?? null;
    bucketOwner = process.env.VSP_AUDIT_BUCKET_OWNER ?? "";
    kmsKey = kmsKey ?? process.env.VSP_AUDIT_KMS_KEY_ID ?? null;
    if (!url || !region || !bucket || !/^\d{12}$/.test(bucketOwner) || !kmsKey) {
      throw new UsageError("--env live needs VSP_AUDIT_VERIFIER_DATABASE_URL, AWS_REGION, VSP_AUDIT_BUCKET, VSP_AUDIT_BUCKET_OWNER and VSP_AUDIT_KMS_KEY_ID");
    }
    db = PgPoolDb.fromConnectionString(url, 2, { applicationName: "vsp-verify-audit" });
    s3 = new S3Client({ region });
    kms = new KMSClient({ region });
  }
  try {
    const sink = s3 && bucket
      ? new S3ObjectLockAuditSink(
          s3,
          // Reader only: retention and lock mode apply to writes and are not used by list/get.
          { bucket, expectedBucketOwner: bucketOwner, keyPrefix: args.prefix, objectLockMode: "GOVERNANCE", retentionClass: "SECURITY_AUDIT", retentionDays: 1, kmsKeyId: "vsp-audit-reader-unused" },
          systemClock,
        )
      : null;
    let signatures: ManifestSignatureVerifier | null = null;
    if (kms && kmsKey) {
      signatures = new ManifestSignatureVerifier();
      await signatures.trustKms(kms, kmsKey);
    }
    return await new AuditExportVerifier({ db, sink, signatures, clock: systemClock }).run({ from: args.from, to: args.to });
  } finally {
    await db.close().catch(() => undefined);
    s3?.destroy();
    kms?.destroy();
    if (cleanup) await cleanup().catch(() => undefined);
  }
}

/** Runs the command with `argv` (without node and script); returns the exit code. */
export async function runVerifyAuditCli(argv: readonly string[], deps: VerifyAuditDeps = {}): Promise<number> {
  let args: VerifyAuditArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`verify-audit: ${(e as Error).message}\n`);
    return EXIT.usage;
  }
  let report: AuditVerificationReport;
  try {
    report = await verifyAudit(args, deps);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`verify-audit: ${e.message}\n`);
      return EXIT.usage;
    }
    const code = (e as { reasonCode?: unknown }).reasonCode;
    process.stderr.write(`verify-audit: dependency unavailable (${typeof code === "string" ? code : "UNREACHABLE"})\n`);
    return EXIT.dependency;
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.json) writeFileSync(args.json, text, "utf8");
  process.stdout.write(text);
  process.stderr.write(`verify-audit: ${report.verdict}${report.reasonCodes.length ? ` (${report.reasonCodes.join(", ")})` : ""}\n`);
  return exitCodeFor(report);
}
