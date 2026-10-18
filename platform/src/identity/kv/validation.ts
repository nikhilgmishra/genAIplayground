import { ValidationError } from "../../shared/errors.js";

/**
 * Shared argument validation for both KvStore implementations so the LOCAL
 * FIXTURE and the DynamoDB store reject exactly the same inputs. Keys are
 * code-built namespaced strings (e.g. `ses#<sha256>`); they never contain
 * bearer values or PHI.
 */
const KEY = /^[a-z][a-z0-9-]{1,31}#[A-Za-z0-9#:_.-]{1,512}$/;

export function assertKey(pk: string): void {
  if (typeof pk !== "string" || !KEY.test(pk)) throw new ValidationError("KV_KEY_INVALID");
}

export function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new ValidationError("KV_VERSION_INVALID");
}

export function assertTtl(ttl: number | null): void {
  if (ttl === null) return;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new ValidationError("KV_TTL_INVALID");
}

export function assertData(data: unknown): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new ValidationError("KV_DATA_INVALID");
}
