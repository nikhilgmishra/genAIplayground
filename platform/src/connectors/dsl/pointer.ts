/**
 * RFC 6901 JSON pointers, bounded (FO-06-23). The only way the mapping DSL addresses data: no
 * wildcards, no filters, no expressions, no function calls. Reading follows OWN properties of plain
 * objects and array indices only (never the prototype chain), and writing refuses the property names
 * that could reach an object prototype.
 */
import { MappingDefinitionError, MappingLimitError } from "./errors.js";

export const MAX_POINTER_DEPTH = 16;
export const MAX_POINTER_LENGTH = 200;

const TOKEN_CHARS = /^([A-Za-z0-9_.$@-]|~[01])*$/;
const FORBIDDEN_TOKENS = new Set(["__proto__", "prototype", "constructor"]);

/** Parses a pointer into unescaped reference tokens; the empty pointer is the whole document. */
export function parsePointer(pointer: string): readonly string[] {
  if (pointer.length > MAX_POINTER_LENGTH) throw new MappingDefinitionError("DSL_POINTER_TOO_LONG");
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new MappingDefinitionError("DSL_POINTER_INVALID");
  const raw = pointer.slice(1).split("/");
  if (raw.length > MAX_POINTER_DEPTH) throw new MappingLimitError("DSL_DEPTH_LIMIT");
  return raw.map((t) => {
    if (!TOKEN_CHARS.test(t)) throw new MappingDefinitionError("DSL_POINTER_INVALID");
    const token = t.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_TOKENS.has(token)) throw new MappingDefinitionError("DSL_POINTER_FORBIDDEN_TOKEN");
    return token;
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Value at the pointer, or `undefined` when any step is absent. Each step costs one unit of the caller's
 * step budget (`spend`), so a pathological document cannot make a lookup unbounded.
 */
export function readPointer(doc: unknown, tokens: readonly string[], spend: () => void = () => undefined): unknown {
  let cur: unknown = doc;
  for (const t of tokens) {
    spend();
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(t)) return undefined;
      const i = Number(t);
      cur = i < cur.length ? cur[i] : undefined;
    } else if (isPlainObject(cur)) {
      cur = Object.hasOwn(cur, t) ? cur[t] : undefined;
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** True when pointer `a` equals pointer `b` or addresses a value inside it (b is a prefix of a). */
export function pointerWithin(a: readonly string[], b: readonly string[]): boolean {
  if (b.length > a.length) return false;
  return b.every((t, i) => a[i] === t);
}

/** Sets `value` at the pointer inside a fresh object tree (objects only; used to build request bodies). */
export function writePointer(target: Record<string, unknown>, tokens: readonly string[], value: unknown): void {
  if (tokens.length === 0) throw new MappingDefinitionError("DSL_POINTER_EMPTY_TARGET");
  let cur: Record<string, unknown> = target;
  tokens.forEach((t, i) => {
    if (FORBIDDEN_TOKENS.has(t)) throw new MappingDefinitionError("DSL_POINTER_FORBIDDEN_TOKEN");
    if (i === tokens.length - 1) {
      if (Object.hasOwn(cur, t)) throw new MappingDefinitionError("DSL_POINTER_TARGET_CONFLICT");
      cur[t] = value;
      return;
    }
    const next = Object.hasOwn(cur, t) ? cur[t] : undefined;
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cur[t] = created;
      cur = created;
    } else if (isPlainObject(next)) {
      cur = next;
    } else {
      throw new MappingDefinitionError("DSL_POINTER_TARGET_CONFLICT");
    }
  });
}
