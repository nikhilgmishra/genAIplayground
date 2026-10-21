/**
 * Production clients wired to the Layer-2 emulators: the same AWS SDK v3 clients and PgPoolDb the
 * live composition uses, with the endpoint pointed at the local service and the generated emulator
 * credentials. Nothing here is a fake.
 */
import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESClient } from "@aws-sdk/client-ses";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { migrate } from "../../../src/db/migrate.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import { localEnv } from "./env.js";
import type { Layer2Context } from "./layer2.js";

export const REGION = "us-east-1";
/** Synthetic AWS account id used in emulated ARNs and AWS-format queue URLs. */
export const SYNTHETIC_ACCOUNT = "123456789012";

const awsCreds = () => ({ accessKeyId: localEnv().awsAccessKeyId, secretAccessKey: localEnv().awsSecretAccessKey });

export const sqsClient = (l2: Layer2Context) => new SQSClient({ region: REGION, endpoint: l2.url("elasticmq", 9324), credentials: awsCreds() });
export const sfnClient = (l2: Layer2Context) => new SFNClient({ region: REGION, endpoint: l2.url("stepfunctions", 8083), credentials: awsCreds() });
export const dynamoClient = (l2: Layer2Context) => new DynamoDBClient({ region: REGION, endpoint: l2.url("dynamodb", 8000), credentials: awsCreds() });
export const kmsClient = (l2: Layer2Context) => new KMSClient({ region: REGION, endpoint: l2.url("localstack", 4566), credentials: awsCreds() });
export const secretsClient = (l2: Layer2Context) => new SecretsManagerClient({ region: REGION, endpoint: l2.url("localstack", 4566), credentials: awsCreds() });
export const snsClient = (l2: Layer2Context) => new SNSClient({ region: REGION, endpoint: l2.url("localstack", 4566), credentials: awsCreds() });
/** SES v1 API: LocalStack Community does not emulate SESv2. */
export const sesClient = (l2: Layer2Context) => new SESClient({ region: REGION, endpoint: l2.url("localstack", 4566), credentials: awsCreds() });
export const s3Client = (l2: Layer2Context) =>
  new S3Client({
    region: REGION,
    endpoint: l2.url("minio", 9000),
    forcePathStyle: true,
    credentials: { accessKeyId: localEnv().minioUser, secretAccessKey: localEnv().minioPassword },
  });

/** AWS-format queue URL (what production configuration holds); ElasticMQ resolves the queue by name. */
export const awsQueueUrl = (name: string): string => `https://sqs.${REGION}.amazonaws.com/${SYNTHETIC_ACCOUNT}/${name}`;

/** Unique, opaque resource name for one test (queues, buckets, realms, databases). */
export const uniqueName = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;

export const postgresUrl = (l2: Layer2Context, database = "vsp"): string =>
  `postgres://vsp:${encodeURIComponent(localEnv().postgresPassword)}@127.0.0.1:${l2.port("postgres", 5432)}/${database}`;

export interface IntegrationDb {
  db: PgPoolDb;
  name: string;
  drop(): Promise<void>;
}

/**
 * Fresh PostgreSQL 16 database with every production migration applied through PgPoolDb (the
 * Aurora adapter): the Layer-2 counterpart of the PGlite createTestDb. Creation is serialized with
 * an advisory lock on the admin database because the foundation migration creates cluster-wide roles.
 */
export async function createIntegrationDb(l2: Layer2Context, poolSize = 8): Promise<IntegrationDb> {
  const name = `vsp_it_${randomBytes(6).toString("hex")}`;
  const admin = PgPoolDb.fromConnectionString(postgresUrl(l2), 2);
  const db = PgPoolDb.fromConnectionString(postgresUrl(l2, name), poolSize);
  try {
    await admin.exec(`create database ${name}`);
    // Transaction-scoped advisory lock on the admin database, held while the migrations run.
    await admin.tx(
      async (tx) => {
        await tx.query("select pg_advisory_xact_lock(7300004)");
        await migrate(db);
      },
      { role: "owner" },
    );
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  } finally {
    await admin.close();
  }
  const pool = db;
  return {
    db: pool,
    name,
    async drop() {
      await pool.close();
      const a = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
      try {
        await a.exec(`drop database if exists ${name} with (force)`);
      } finally {
        await a.close();
      }
    },
  };
}
