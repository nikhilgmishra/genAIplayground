/**
 * Field-level minimization (spec section 7: "Apply field-level minimization";
 * DATA-01). Pure function; property-tested in mask.test.ts.
 *
 * Contract (see MaskTarget in ports.ts): policy field masks are paths relative to
 * each protected RECORD, e.g. "startsAt" or "lines.amountMinor" (arrays are
 * traversed element-wise). Inside `data[collectionKey]` (array elements or a
 * single object; `collectionKey: null` means `data` itself is the record) only
 * masked paths are kept; at the top level of `data` only the declared
 * non-protected `envelopeKeys` are kept. Everything else is stripped.
 *
 * Guarantees: the result never contains a key that the input did not have, never
 * contains a path outside the mask (plus envelope keys), keeps kept leaf values
 * unchanged, and is idempotent. Prototype-polluting segments are never honoured.
 */
import type { MaskTarget } from "./ports.js";

type Tree = Map<string, Tree | true>;

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Builds the path tree. A leaf (`true`) keeps the whole value; a deeper path keeps only its subtree. */
export function maskTree(paths: readonly string[]): Tree {
  const root: Tree = new Map();
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const segments = path.split(".");
    if (segments.length === 0 || segments.some((s) => !SEGMENT.test(s) || FORBIDDEN_SEGMENTS.has(s))) continue;
    let node: Tree = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const existing = node.get(seg);
      if (existing === true) break; // an ancestor already keeps everything below it
      if (i === segments.length - 1) {
        node.set(seg, true);
        break;
      }
      if (existing === undefined) {
        const child: Tree = new Map();
        node.set(seg, child);
        node = child;
      } else node = existing;
    }
  }
  return root;
}

function cloneJson(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(cloneJson);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_SEGMENTS.has(k)) continue;
    out[k] = cloneJson(val);
  }
  return out;
}

function maskValue(value: unknown, tree: Tree): unknown {
  if (Array.isArray(value)) {
    // Arrays are traversed element-wise; only object elements can carry masked paths.
    const out: unknown[] = [];
    for (const el of value) {
      if (isPlainObject(el)) out.push(maskRecord(el, tree));
    }
    return out;
  }
  if (isPlainObject(value)) return maskRecord(value, tree);
  return undefined; // a scalar where the mask expects structure is dropped
}

/** Keeps only the masked paths of one record. */
export function maskRecord(record: Record<string, unknown>, tree: Tree): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of tree) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    if (node === true) {
      out[key] = cloneJson(value);
      continue;
    }
    const masked = maskValue(value, node);
    if (masked !== undefined) out[key] = masked;
  }
  return out;
}

/**
 * Applies the policy field mask to tool output `data` per the tool's MaskTarget.
 * Never throws for well-formed JSON data; unknown shapes are stripped.
 */
export function applyFieldMask(data: Record<string, unknown>, fieldMask: readonly string[], target: MaskTarget): Record<string, unknown> {
  if (!isPlainObject(data)) return {};
  const tree = maskTree(fieldMask);
  const envelope = new Set(
    (Array.isArray(target?.envelopeKeys) ? target.envelopeKeys : []).filter((k) => typeof k === "string" && SEGMENT.test(k) && !FORBIDDEN_SEGMENTS.has(k)),
  );
  const collectionKey = typeof target?.collectionKey === "string" && SEGMENT.test(target.collectionKey) && !FORBIDDEN_SEGMENTS.has(target.collectionKey) ? target.collectionKey : null;
  if (target?.collectionKey !== null && collectionKey === null) return {}; // malformed target: strip everything (fail closed)

  if (collectionKey === null) {
    const out = maskRecord(data, tree);
    // Envelope keys are declared non-protected and kept whole (they take precedence over a narrower path).
    for (const k of envelope) {
      if (Object.hasOwn(data, k) && data[k] !== undefined) out[k] = cloneJson(data[k]);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const k of envelope) {
    if (k === collectionKey) continue;
    if (Object.hasOwn(data, k) && data[k] !== undefined) out[k] = cloneJson(data[k]);
  }
  if (Object.hasOwn(data, collectionKey)) {
    const collection = data[collectionKey];
    if (collection === null) out[collectionKey] = null;
    else {
      const masked = maskValue(collection, tree);
      if (masked !== undefined) out[collectionKey] = masked;
    }
  }
  return out;
}

/** Every leaf path present in a JSON value (arrays flattened element-wise), for tests and audits of masks. */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => leafPaths(v, prefix));
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return prefix ? [prefix] : [];
    return keys.flatMap((k) => leafPaths(value[k], prefix ? `${prefix}.${k}` : k));
  }
  return prefix ? [prefix] : [];
}
