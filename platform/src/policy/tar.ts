/**
 * Minimal, bounded reader for the gzip'd tar bundles produced by `opa build`.
 *
 * The engine reads policy.wasm, data.json and .manifest straight out of
 * bundle.tar.gz so that what is evaluated is exactly the artifact whose sha256
 * is reported as `bundleDigest` (OPS-06). Only regular files are returned;
 * header checksums are verified; PAX `path` overrides are honoured; links,
 * devices and oversized or malformed archives are rejected with reason codes.
 */
import { gunzipSync } from "node:zlib";
import { PlatformError } from "../shared/errors.js";

export class BundleArchiveError extends PlatformError {}

export interface TarLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxCompressedBytes: 32 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 512,
};

const BLOCK = 512;

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function octal(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length);
  if (((field[0] ?? 0) & 0x80) !== 0) throw new BundleArchiveError("BUNDLE_TAR_BASE256_UNSUPPORTED");
  const text = cString(buf, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new BundleArchiveError("BUNDLE_TAR_HEADER_INVALID");
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === expected;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new BundleArchiveError("BUNDLE_TAR_PAX_INVALID");
    const len = Number(body.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || offset + len > body.length) throw new BundleArchiveError("BUNDLE_TAR_PAX_INVALID");
    const record = body.subarray(space + 1, offset + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += len;
  }
  return out;
}

/** Normalizes "/x", "./x" to "x"; rejects traversal. */
export function normalizeEntryName(name: string): string {
  const n = name.replace(/^(\.\/|\/)+/, "");
  if (n === "" || n.split("/").some((part) => part === "..")) throw new BundleArchiveError("BUNDLE_TAR_PATH_INVALID");
  return n;
}

/** Parses an uncompressed tar archive into a map of regular files. */
export function readTar(archive: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let entries = 0;
  let paxPath: string | null = null;
  let total = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) throw new BundleArchiveError("BUNDLE_TAR_CHECKSUM_INVALID");
    entries += 1;
    if (entries > limits.maxEntries) throw new BundleArchiveError("BUNDLE_TAR_TOO_MANY_ENTRIES");
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const magic = cString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
    const rawName = cString(header, 0, 100);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new BundleArchiveError("BUNDLE_TAR_TRUNCATED");
    total += size;
    if (total > limits.maxUncompressedBytes) throw new BundleArchiveError("BUNDLE_TAR_TOO_LARGE");
    const body = archive.subarray(dataStart, dataEnd);
    if (type === "x") {
      paxPath = parsePax(body).path ?? null;
    } else if (type === "g") {
      // global PAX header: no per-file meaning here
    } else if (type === "0" || type === "\0" || type === "7") {
      const entryName = normalizeEntryName(paxPath ?? name);
      if (files.has(entryName)) throw new BundleArchiveError("BUNDLE_TAR_DUPLICATE_ENTRY");
      files.set(entryName, Buffer.from(body));
      paxPath = null;
    } else if (type === "5") {
      paxPath = null;
    } else {
      throw new BundleArchiveError("BUNDLE_TAR_ENTRY_TYPE_UNSUPPORTED");
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** Gunzips (bounded) and parses a .tar.gz archive. */
export function readTarGz(compressed: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): Map<string, Buffer> {
  if (compressed.length > limits.maxCompressedBytes) throw new BundleArchiveError("BUNDLE_TAR_TOO_LARGE");
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: limits.maxUncompressedBytes + 1024 * BLOCK });
  } catch {
    throw new BundleArchiveError("BUNDLE_GZIP_INVALID");
  }
  return readTar(archive, limits);
}
