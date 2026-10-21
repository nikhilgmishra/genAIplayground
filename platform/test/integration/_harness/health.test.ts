/**
 * Layer 2: protocol-level health of every core service (WP-03 acceptance: `make up PROFILE=core &&
 * make test-integration SUITE=_harness`). Each check speaks the service's real protocol with the
 * client the platform uses (AWS SDK v3, node-postgres, livekit-server-sdk, jose's fetch) rather than
 * only reading the container health flag.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateKeyCommand, GetPublicKeyCommand, SignCommand, VerifyCommand } from "@aws-sdk/client-kms";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { CreateSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ListIdentitiesCommand, SESClient, VerifyDomainIdentityCommand } from "@aws-sdk/client-ses";
import { ListStateMachinesCommand } from "@aws-sdk/client-sfn";
import { CreateTopicCommand, DeleteTopicCommand } from "@aws-sdk/client-sns";
import { CreateQueueCommand, DeleteQueueCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { RoomServiceClient } from "livekit-server-sdk";
import { describe, expect } from "vitest";
import { PgPoolDb } from "../../../src/db/pg.js";
import { dynamoClient, kmsClient, postgresUrl, s3Client, secretsClient, sesClient, sfnClient, snsClient, sqsClient, uniqueName } from "./clients.js";
import { CORE_SERVICES, layer2 } from "./layer2.js";
import { localEnv } from "./env.js";
import { clamdInstream, eicarTestFile, resp, sipOptions, smtpSend, tcpExchange } from "./protocols.js";

describe("Layer-2 core composition health (protocol level)", () => {
  layer2([...CORE_SERVICES])("[FO-16-01][FO-19-63] every core service is running, healthy, pinned by digest and bound to 127.0.0.1", ({ l2 }) => {
    for (const name of CORE_SERVICES) {
      const s = l2.service(name);
      expect(s.health, name).toBe("healthy");
      expect(s.image, name).toMatch(/:[^@]+@sha256:[0-9a-f]{64}$/);
      expect(s.label.emulates, name).not.toBe("UNLABELLED");
      expect(s.label.notEmulated, name).not.toBe("UNLABELLED");
      expect(Object.keys(s.ports).length, name).toBeGreaterThan(0);
    }
  });

  layer2(["postgres"])("[FO-16-14] postgres: PostgreSQL 16 with pgvector answers through PgPoolDb", async ({ l2 }) => {
    const db = PgPoolDb.fromConnectionString(postgresUrl(l2), 2);
    try {
      const v = await db.query<{ v: string }>("select current_setting('server_version_num') as v");
      const num = Number(v.rows[0]?.v);
      expect(num).toBeGreaterThanOrEqual(160000);
      expect(num).toBeLessThan(170000);
      const ext = await db.query<{ name: string }>("select name from pg_available_extensions where name = 'vector'");
      expect(ext.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  layer2(["dynamodb"])("dynamodb: DynamoDB Local round-trips a conditional write", async ({ l2 }) => {
    const ddb: DynamoDBClient = dynamoClient(l2);
    const table = uniqueName("vsp-it-health");
    await ddb.send(new CreateTableCommand({ TableName: table, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }));
    try {
      await ddb.send(new PutItemCommand({ TableName: table, Item: { pk: { S: "k1" }, v: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)" }));
      await expect(ddb.send(new PutItemCommand({ TableName: table, Item: { pk: { S: "k1" }, v: { N: "2" } }, ConditionExpression: "attribute_not_exists(pk)" }))).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
      const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: "k1" } }, ConsistentRead: true }));
      expect(got.Item?.v?.N).toBe("1");
    } finally {
      await ddb.send(new DeleteTableCommand({ TableName: table }));
    }
  });

  layer2(["elasticmq"])("elasticmq: SQS send, receive and delete", async ({ l2 }) => {
    const sqs = sqsClient(l2);
    const q = await sqs.send(new CreateQueueCommand({ QueueName: uniqueName("vsp-it-health") }));
    try {
      await sqs.send(new SendMessageCommand({ QueueUrl: q.QueueUrl, MessageBody: "health" }));
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl, WaitTimeSeconds: 2 }));
      expect(r.Messages?.[0]?.Body).toBe("health");
      await sqs.send(new DeleteMessageCommand({ QueueUrl: q.QueueUrl, ReceiptHandle: r.Messages?.[0]?.ReceiptHandle }));
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: q.QueueUrl }));
    }
  });

  layer2(["minio"])("minio: S3 API answers with SigV4 credentials and the health endpoint is live", async ({ l2 }) => {
    const live = await fetch(`${l2.url("minio", 9000)}/minio/health/live`);
    expect(live.status).toBe(200);
    const buckets = await s3Client(l2).send(new ListBucketsCommand({}));
    expect(Array.isArray(buckets.Buckets ?? [])).toBe(true);
  });

  layer2(["localstack"])("localstack: KMS signs and verifies, Secrets Manager stores, SNS and SES answer", async ({ l2 }) => {
    const health = (await (await fetch(`${l2.url("localstack", 4566)}/_localstack/health`)).json()) as { services: Record<string, string> };
    for (const svc of ["kms", "secretsmanager", "sns", "ses"]) expect(["available", "running"]).toContain(health.services[svc]);
    const kms = kmsClient(l2);
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: "vsp layer-2 health (synthetic)" }));
    const keyId = key.KeyMetadata?.KeyId ?? "";
    const message = Buffer.from("layer-2 health digest");
    const sig = await kms.send(new SignCommand({ KeyId: keyId, Message: message, MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }));
    const ok = await kms.send(new VerifyCommand({ KeyId: keyId, Message: message, MessageType: "RAW", Signature: sig.Signature, SigningAlgorithm: "ECDSA_SHA_256" }));
    expect(ok.SignatureValid).toBe(true);
    const pub = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
    expect(pub.KeySpec).toBe("ECC_NIST_P256");
    const secrets = secretsClient(l2);
    const name = uniqueName("vsp/it/health");
    await secrets.send(new CreateSecretCommand({ Name: name, SecretString: "synthetic-not-a-secret" }));
    expect((await secrets.send(new GetSecretValueCommand({ SecretId: name }))).SecretString).toBe("synthetic-not-a-secret");
    const sns = snsClient(l2);
    const topic = await sns.send(new CreateTopicCommand({ Name: uniqueName("vsp-it-health") }));
    expect(topic.TopicArn).toMatch(/^arn:aws:sns:/);
    await sns.send(new DeleteTopicCommand({ TopicArn: topic.TopicArn }));
    // LocalStack Community emulates the SES v1 API (SESv2 is answered with "not emulated"): see the README.
    const ses: SESClient = sesClient(l2);
    const verified = await ses.send(new VerifyDomainIdentityCommand({ Domain: "layer2.example.test" }));
    expect(verified.VerificationToken).toBeTruthy();
    expect((await ses.send(new ListIdentitiesCommand({}))).Identities).toContain("layer2.example.test");
  });

  layer2(["keycloak"])("[FO-16-13] keycloak: OIDC discovery is served over HTTPS with the checkout's local CA", async ({ l2 }) => {
    const port = l2.port("keycloak", 8443);
    const issuer = `https://localhost:${port}/realms/master`;
    // Trusted through NODE_EXTRA_CA_CERTS (set by the runner to the checkout's local CA); no TLS check is disabled.
    const doc = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
    expect(doc.issuer).toBe(issuer);
    expect(doc.jwks_uri).toBe(`${issuer}/protocol/openid-connect/certs`);
  });

  layer2(["stepfunctions"])("stepfunctions: Step Functions Local answers the JSON API", async ({ l2 }) => {
    const r = await sfnClient(l2).send(new ListStateMachinesCommand({}));
    expect(Array.isArray(r.stateMachines)).toBe(true);
  });

  layer2(["mailpit"])("mailpit: accepts SMTP and exposes the captured message over its API", async ({ l2 }) => {
    const subject = `layer2-health-${Date.now()}`;
    const replies = await smtpSend(l2.port("mailpit", 1025), "noreply@layer2.example.test", "synthetic.recipient@layer2.example.test", `Subject: ${subject}\n\nsynthetic body`);
    expect(replies.at(-2)).toMatch(/^250/);
    const found = (await (await fetch(`${l2.url("mailpit", 8025)}/api/v1/search?query=${encodeURIComponent(`subject:${subject}`)}`)).json()) as { messages_count: number };
    expect(found.messages_count).toBe(1);
  });

  layer2(["clamav"])("clamav: clamd answers PING and detects the EICAR test file over INSTREAM", async ({ l2 }) => {
    const port = l2.port("clamav", 3310);
    expect((await tcpExchange(port, "zPING\0")).replace(/\0/g, "").trim()).toBe("PONG");
    expect(await tcpExchange(port, "zVERSION\0")).toMatch(/^ClamAV 1\.5\./);
    expect(await clamdInstream(port, eicarTestFile())).toMatch(/stream: .*FOUND/);
    expect(await clamdInstream(port, Buffer.from("plain synthetic document"))).toMatch(/stream: OK/);
  });

  layer2(["valkey"])("valkey: RESP PING requires the generated password", async ({ l2 }) => {
    const port = l2.port("valkey", 6379);
    expect(await tcpExchange(port, resp("PING") + resp("QUIT"))).toMatch(/NOAUTH/);
    expect(await tcpExchange(port, resp("AUTH", localEnv().valkeyPassword) + resp("PING") + resp("QUIT"))).toMatch(/\+OK\r\n\+PONG/);
  });

  layer2(["livekit"])("livekit: the server API authenticates livekit-server-sdk requests with the generated key", async ({ l2 }) => {
    const svc = new RoomServiceClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);
    expect(Array.isArray(await svc.listRooms())).toBe(true);
    const forged = new RoomServiceClient(l2.url("livekit", 7880), localEnv().livekitApiKey, "0".repeat(64));
    await expect(forged.listRooms()).rejects.toThrow();
  });

  layer2(["livekit-sip"])("livekit-sip: answers a SIP OPTIONS request over UDP", async ({ l2 }) => {
    const response = await sipOptions(l2.port("livekit-sip", 5060, "udp"));
    expect(response).toMatch(/^SIP\/2\.0 \d{3} /);
    expect(response).toMatch(/CSeq: 1 OPTIONS/i);
  });
});
