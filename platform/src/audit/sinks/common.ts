import { AuditManifest } from "../../protocol/index.js";
import type { AuditManifest as AuditManifestType } from "../../protocol/index.js";
import { PlatformError } from "../../shared/errors.js";
import { batchDigestOf, objectKeyFor, parseObjectKey } from "../chain.js";
import { STREAM_NAME_RE } from "../schema.js";

/** Sink failure with a stable reason code (no object content or paths in the message). */
export class AuditSinkError extends PlatformError {
  constructor(reasonCode: string, retryable = false) {
    super(reasonCode, reasonCode, retryable);
  }
}

export const MANIFEST_SUFFIX = ".manifest.json";

/**
 * Defense in depth: a sink refuses a batch whose manifest does not describe the
 * NDJSON body exactly (digest, key, sequence range and line count).
 */
export function assertBatchConsistent(manifest: AuditManifestType, ndjson: string): AuditManifestType {
  const parsed = AuditManifest.safeParse(manifest);
  if (!parsed.success) throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
  const m = parsed.data;
  const key = parseObjectKey(m.objectKey);
  if (
    !key ||
    !STREAM_NAME_RE.test(m.sourceStream) ||
    key.stream !== m.sourceStream ||
    key.firstSequence !== m.firstSequence ||
    key.lastSequence !== m.lastSequence ||
    objectKeyFor(m.sourceStream, m.firstSequence, m.lastSequence) !== m.objectKey
  ) {
    throw new AuditSinkError("AUDIT_SINK_OBJECT_KEY_INVALID");
  }
  if (m.lastSequence - m.firstSequence + 1 !== m.eventCount) throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
  if (batchDigestOf(ndjson) !== m.batchDigest) throw new AuditSinkError("AUDIT_SINK_DIGEST_MISMATCH");
  const lines = ndjson.endsWith("\n") ? ndjson.slice(0, -1).split("\n") : [];
  if (lines.length !== m.eventCount) throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
  return m;
}

export function assertStreamForListing(stream: string): void {
  if (!STREAM_NAME_RE.test(stream) || stream.includes("..")) throw new AuditSinkError("AUDIT_STREAM_INVALID");
}
