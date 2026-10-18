import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { KvItem, KvStore } from "../ports.js";
import { assertData, assertKey, assertTtl, assertVersion } from "./validation.js";

/**
 * DynamoDB KvStore (kind "live") over `@aws-sdk/lib-dynamodb`.
 *
 * Table contract (infra/terraform/modules/dynamodb_sessions): hash key `pk` (S),
 * TTL attribute `ttl` (epoch seconds, cleanup only). Item attributes:
 * `pk`, `version` (N), `data` (M) or `counter` (N), optional `ttl` (N).
 *
 *  - get:            GetCommand, ConsistentRead (session reads must see the latest CAS).
 *  - putIfAbsent:    PutCommand + ConditionExpression `attribute_not_exists(pk)`.
 *  - compareAndSwap: PutCommand (full replace, version = expected + 1) +
 *                    ConditionExpression `#v = :expected`.
 *  - delete:         DeleteCommand + `attribute_exists(pk)` or `#v = :expected`.
 *  - increment:      UpdateCommand `ADD #c :one, #v :one SET #t = if_not_exists(#t, :ttl)`.
 *
 * `ConditionalCheckFailedException` maps to `false`. Every other SDK error is
 * re-thrown as a reason-coded DependencyError (the SDK message is dropped: it can
 * echo request content). Writes that fail for an unknown reason are reported as
 * outcome UNKNOWN because DynamoDB may have applied them.
 *
 * DynamoDB TTL deletion is not immediate; readers enforce expiry (AUTH-04).
 * Global-table replicas evaluate conditions per region (last writer wins), which is
 * why the platform keeps one write region.
 *
 * STATUS: contract-tested with an injected stub client only. Not run against
 * DynamoDB or DynamoDB Local in this repository (no container runtime here).
 */
export interface DocumentSender {
  send(command: GetCommand | PutCommand | UpdateCommand | DeleteCommand): Promise<unknown>;
}

const isConditionalFailure = (err: unknown): boolean =>
  err instanceof ConditionalCheckFailedException ||
  (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ConditionalCheckFailedException");

export class DynamoKvStore implements KvStore {
  readonly kind = "live" as const;

  constructor(
    private readonly client: DocumentSender,
    private readonly tableName: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new ValidationError("KV_TABLE_NAME_INVALID");
  }

  /** Wraps a low-level DynamoDBClient in a DocumentClient with strict marshalling (undefined values are rejected). */
  static fromClient(client: DynamoDBClient, tableName: string): DynamoKvStore {
    const doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: false, convertClassInstanceToMap: false, convertEmptyValues: false },
      unmarshallOptions: { wrapNumbers: false },
    });
    return new DynamoKvStore(doc, tableName);
  }

  async get<T>(pk: string): Promise<KvItem<T> | null> {
    assertKey(pk);
    let out: unknown;
    try {
      out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk }, ConsistentRead: true }));
    } catch {
      throw new DependencyError("KV_READ_FAILED", "FAILED", true);
    }
    const item = (out as { Item?: Record<string, unknown> } | undefined)?.Item;
    if (!item) return null;
    return toKvItem<T>(pk, item);
  }

  async putIfAbsent<T>(item: KvItem<T>): Promise<boolean> {
    assertKey(item.pk);
    assertVersion(item.version);
    assertTtl(item.ttlEpochSeconds);
    assertData(item.data);
    const Item: Record<string, unknown> = { pk: item.pk, version: item.version, data: item.data };
    if (item.ttlEpochSeconds !== null) Item.ttl = item.ttlEpochSeconds;
    return this.conditionalWrite(
      new PutCommand({ TableName: this.tableName, Item, ConditionExpression: "attribute_not_exists(pk)" }),
    );
  }

  async compareAndSwap<T>(pk: string, expectedVersion: number, data: T, ttlEpochSeconds: number | null): Promise<boolean> {
    assertKey(pk);
    assertVersion(expectedVersion);
    assertTtl(ttlEpochSeconds);
    assertData(data);
    const Item: Record<string, unknown> = { pk, version: expectedVersion + 1, data };
    if (ttlEpochSeconds !== null) Item.ttl = ttlEpochSeconds;
    return this.conditionalWrite(
      new PutCommand({
        TableName: this.tableName,
        Item,
        ConditionExpression: "#v = :expected",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: { ":expected": expectedVersion },
      }),
    );
  }

  async delete(pk: string, expectedVersion?: number): Promise<boolean> {
    assertKey(pk);
    if (expectedVersion !== undefined) assertVersion(expectedVersion);
    const cmd =
      expectedVersion === undefined
        ? new DeleteCommand({ TableName: this.tableName, Key: { pk }, ConditionExpression: "attribute_exists(pk)" })
        : new DeleteCommand({
            TableName: this.tableName,
            Key: { pk },
            ConditionExpression: "#v = :expected",
            ExpressionAttributeNames: { "#v": "version" },
            ExpressionAttributeValues: { ":expected": expectedVersion },
          });
    return this.conditionalWrite(cmd);
  }

  async increment(pk: string, ttlEpochSeconds: number): Promise<number> {
    assertKey(pk);
    assertTtl(ttlEpochSeconds);
    let out: unknown;
    try {
      out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk },
          UpdateExpression: "ADD #c :one, #v :one SET #t = if_not_exists(#t, :ttl)",
          ExpressionAttributeNames: { "#c": "counter", "#v": "version", "#t": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":ttl": ttlEpochSeconds },
          ReturnValues: "UPDATED_NEW",
        }),
      );
    } catch {
      // A counter increment that may or may not have applied: callers treat this as a
      // throttle-store failure and fail closed (no challenge is sent).
      throw new DependencyError("KV_INCREMENT_FAILED", "UNKNOWN", false);
    }
    const counter = (out as { Attributes?: Record<string, unknown> } | undefined)?.Attributes?.counter;
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 1) {
      throw new DependencyError("KV_INCREMENT_RESPONSE_INVALID", "UNKNOWN", false);
    }
    return counter;
  }

  private async conditionalWrite(cmd: PutCommand | DeleteCommand): Promise<boolean> {
    try {
      await this.client.send(cmd);
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw new DependencyError("KV_WRITE_FAILED", "UNKNOWN", false);
    }
  }
}

function toKvItem<T>(pk: string, item: Record<string, unknown>): KvItem<T> {
  const version = item.version;
  const ttl = item.ttl;
  if (item.pk !== pk || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new DependencyError("KV_ITEM_MALFORMED", "FAILED", false);
  }
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isSafeInteger(ttl))) {
    throw new DependencyError("KV_ITEM_MALFORMED", "FAILED", false);
  }
  let data: unknown = item.data;
  if (data === undefined && typeof item.counter === "number") data = { count: item.counter };
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new DependencyError("KV_ITEM_MALFORMED", "FAILED", false);
  return { pk, version, ttlEpochSeconds: typeof ttl === "number" ? ttl : null, data: data as T };
}
