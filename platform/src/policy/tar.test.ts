import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { ensurePolicyBundle } from "./ensure-bundle.js";
import { BundleArchiveError, normalizeEntryName, readTar, readTarGz } from "./tar.js";

/** Builds a minimal ustar header + body for tests. */
function entry(name: string, body: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, pad]);
}
const end = () => Buffer.alloc(1024, 0);

describe("bundle archive reader", () => {
  let bundleDir: string;
  beforeAll(() => {
    bundleDir = ensurePolicyBundle().bundleDir;
  });

  it("[OPS-06] reads exactly the files opa build produced", () => {
    const files = readTarGz(readFileSync(join(bundleDir, "bundle.tar.gz")));
    expect([...files.keys()].sort()).toEqual([".manifest", "data.json", "policy.wasm", "vsp/authz.rego", "vsp/console.rego", "vsp/lib.rego"]);
    expect(files.get("policy.wasm")?.equals(readFileSync(join(bundleDir, "policy.wasm")))).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith("_test.rego"))).toBe(false);
  });

  it("[OPS-06] rejects header checksum corruption", () => {
    const tar = Buffer.concat([entry("a.json", Buffer.from("{}")), end()]);
    tar[0] = "b".charCodeAt(0);
    expect(() => readTar(tar)).toThrow(BundleArchiveError);
  });

  it("[OPS-06] rejects truncated archives, links, duplicates and path traversal", () => {
    const full = entry("a.json", Buffer.from("x".repeat(600)));
    expect(() => readTar(full.subarray(0, 700))).toThrow(/BUNDLE_TAR_TRUNCATED/);
    expect(() => readTar(Buffer.concat([entry("link", Buffer.alloc(0), "2"), end()]))).toThrow(/BUNDLE_TAR_ENTRY_TYPE_UNSUPPORTED/);
    expect(() => readTar(Buffer.concat([entry("a", Buffer.from("1")), entry("/a", Buffer.from("2")), end()]))).toThrow(/BUNDLE_TAR_DUPLICATE_ENTRY/);
    expect(() => readTar(Buffer.concat([entry("../escape", Buffer.from("1")), end()]))).toThrow(/BUNDLE_TAR_PATH_INVALID/);
    expect(() => normalizeEntryName("vsp/../../x")).toThrow(BundleArchiveError);
    expect(normalizeEntryName("./data.json")).toBe("data.json");
    expect(normalizeEntryName("/data.json")).toBe("data.json");
  });

  it("[OPS-06] honours PAX path headers and skips directories", () => {
    const pax = Buffer.from("18 path=long/name\n");
    const tar = Buffer.concat([entry("PaxHeader", pax, "x"), entry("short", Buffer.from("v")), entry("dir/", Buffer.alloc(0), "5"), end()]);
    const files = readTar(tar);
    expect([...files.keys()]).toEqual(["long/name"]);
  });

  it("[OPS-06] enforces size and entry limits and rejects non-gzip input", () => {
    const tar = Buffer.concat([entry("a", Buffer.from("123")), entry("b", Buffer.from("456")), end()]);
    expect(() => readTar(tar, { maxCompressedBytes: 1e6, maxUncompressedBytes: 1e6, maxEntries: 1 })).toThrow(/BUNDLE_TAR_TOO_MANY_ENTRIES/);
    expect(() => readTar(tar, { maxCompressedBytes: 1e6, maxUncompressedBytes: 4, maxEntries: 10 })).toThrow(/BUNDLE_TAR_TOO_LARGE/);
    expect(() => readTarGz(Buffer.from("not gzip"))).toThrow(/BUNDLE_GZIP_INVALID/);
    expect(readTarGz(gzipSync(tar)).get("b")?.toString()).toBe("456");
  });
});
