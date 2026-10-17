/**
 * LOCAL FIXTURE audit sink: writes batches to a local directory and simulates
 * S3 Object Lock WORM semantics — an existing object is never overwritten with
 * different content; an identical re-put is a no-op (idempotent shipping).
 *
 * It is NOT independent evidence storage: the directory lives on the same host
 * and can be deleted by anyone with filesystem access. Production configuration
 * must use S3ObjectLockAuditSink in the separately administered audit account (OPS-04).
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AuditManifest } from "../../protocol/index.js";
import type { AuditManifest as AuditManifestType } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import { OBJECT_KEY_RE } from "../chain.js";
import type { AuditSink } from "../ports.js";
import { AuditSinkError, MANIFEST_SUFFIX, assertBatchConsistent, assertStreamForListing } from "./common.js";

export const LOCAL_SINK_BADGE = "LOCAL FIXTURE AUDIT SINK — NOT INDEPENDENT EVIDENCE STORAGE";

export class LocalFsAuditSinkFixture implements AuditSink {
  readonly kind = "local_fixture" as const;
  readonly badge = LOCAL_SINK_BADGE;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async putBatch(manifest: AuditManifestType, eventsNdjson: string): Promise<void> {
    const m = assertBatchConsistent(manifest, eventsNdjson);
    // Body first, manifest last: a manifest's presence means its batch is complete.
    await this.putOnce(m.objectKey, eventsNdjson);
    await this.putOnce(`${m.objectKey}${MANIFEST_SUFFIX}`, canonicalJson(m));
  }

  async listManifests(stream: string): Promise<AuditManifestType[]> {
    assertStreamForListing(stream);
    const dir = this.pathFor(`${stream}/`);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
    const manifests: AuditManifestType[] = [];
    for (const name of names.filter((n) => n.endsWith(MANIFEST_SUFFIX)).sort()) {
      const raw = await readFile(join(dir, name), "utf8");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
      }
      const parsed = AuditManifest.safeParse(json);
      if (!parsed.success || `${parsed.data.objectKey}${MANIFEST_SUFFIX}` !== `${stream}/${name}`) {
        throw new AuditSinkError("AUDIT_SINK_MANIFEST_INVALID");
      }
      manifests.push(parsed.data);
    }
    return manifests.sort((a, b) => a.firstSequence - b.firstSequence || a.lastSequence - b.lastSequence);
  }

  async getBatch(objectKey: string): Promise<string> {
    if (!OBJECT_KEY_RE.test(objectKey)) throw new AuditSinkError("AUDIT_SINK_OBJECT_KEY_INVALID");
    try {
      return await readFile(this.pathFor(objectKey), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AuditSinkError("AUDIT_SINK_OBJECT_MISSING");
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
  }

  private pathFor(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new AuditSinkError("AUDIT_SINK_OBJECT_KEY_INVALID");
    return p;
  }

  private async putOnce(key: string, body: string): Promise<void> {
    const path = this.pathFor(key);
    // Write a private temp file, then hard-link it into place: link() is atomic and
    // fails if the target exists, so a crash never leaves a partial object behind.
    const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
    } catch {
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
    let exists = false;
    try {
      await link(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(tmp).catch(() => undefined);
        throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
      }
      exists = true;
    }
    await unlink(tmp).catch(() => undefined);
    if (!exists) return;
    const existing = await readFile(path, "utf8");
    if (existing !== body) throw new AuditSinkError("AUDIT_SINK_OBJECT_EXISTS");
  }
}
