import { generateKeyPairSync, sign as cryptoSign, constants } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalScope } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import {
  APPROVER_ROLES_BY_SCOPE,
  SUBJECT_KIND_BY_SCOPE,
  FileTrustedKeyResolver,
  KmsTrustedKeyResolver,
  approvalSigningPayload,
  evaluateApproval,
  loadApprovalRecords,
  parseTrustedPublicKey,
  verifyApprovalSignature,
} from "./approvals.js";
import type { ApprovalSubjectExpectations } from "./approvals.js";
import { REPO_ROOT } from "./loader.js";

/**
 * TEST-ONLY key material, generated in memory for this test run. It is never
 * written to approvals/ and has no authority anywhere.
 */
const TEST_ONLY_ED25519 = generateKeyPairSync("ed25519");
const TEST_ONLY_P256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_ONLY_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });

type Alg = "ed25519" | "ecdsa-p256-sha256" | "rsa-pss-sha256";
function testOnlySign(record: ApprovalRecord, privateKey: KeyObject, alg: Alg): ApprovalRecord {
  const data = Buffer.from(approvalSigningPayload(record), "utf8");
  let sig: Buffer;
  if (alg === "ed25519") sig = cryptoSign(null, data, privateKey);
  else if (alg === "ecdsa-p256-sha256") sig = cryptoSign("sha256", data, { key: privateKey, dsaEncoding: "der" });
  else sig = cryptoSign("sha256", data, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  return { ...record, signature: `${alg}:${sig.toString("base64")}` };
}

const clock = new FakeClock("2026-10-17T15:00:00.000Z");
const baseRecord = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: "apr_TESTONLYrecord0001",
  approver: { name: "Test Only Approver", role: "security_leadership" },
  scope: "SECURITY_REVIEW",
  scopeDetail: "TEST-ONLY record used to exercise signature verification; carries no authority",
  environment: "production",
  grantedAt: "2026-10-16T15:00:00.000Z",
  expiresAt: "2026-11-16T15:00:00.000Z",
  evidenceRef: "test://approvals.test.ts",
  signature: null,
  ...over,
});

describe("approval signature verification", () => {
  it("[OPS-04] verifies detached signatures for ed25519, ECDSA P-256 and RSA-PSS trusted keys", () => {
    const cases: [Alg, { privateKey: KeyObject; publicKey: KeyObject }][] = [
      ["ed25519", TEST_ONLY_ED25519],
      ["ecdsa-p256-sha256", TEST_ONLY_P256],
      ["rsa-pss-sha256", TEST_ONLY_RSA],
    ];
    for (const [alg, kp] of cases) {
      const signed = testOnlySign(baseRecord(), kp.privateKey, alg);
      expect(verifyApprovalSignature(signed, kp.publicKey)).toBe("VERIFIED");
      expect(evaluateApproval(signed, { environment: "production", now: clock.now(), trustedKey: kp.publicKey }).status).toBe("VALID");
    }
  });

  it("[OPS-04] a tampered record, a foreign key or an algorithm mismatch fails verification", () => {
    const signed = testOnlySign(baseRecord(), TEST_ONLY_ED25519.privateKey, "ed25519");
    expect(verifyApprovalSignature({ ...signed, expiresAt: "2030-01-01T00:00:00.000Z" }, TEST_ONLY_ED25519.publicKey)).toBe("SIGNATURE_INVALID");
    expect(verifyApprovalSignature({ ...signed, scope: "PHI_PROCESSING" }, TEST_ONLY_ED25519.publicKey)).toBe("SIGNATURE_INVALID");
    const other = generateKeyPairSync("ed25519");
    expect(verifyApprovalSignature(signed, other.publicKey)).toBe("SIGNATURE_INVALID");
    expect(verifyApprovalSignature(signed, TEST_ONLY_P256.publicKey)).toBe("SIGNATURE_ALGORITHM_MISMATCH");
    expect(verifyApprovalSignature({ ...signed, signature: "ed25519:not base64 !!" }, TEST_ONLY_ED25519.publicKey)).toBe("SIGNATURE_INVALID");
    expect(verifyApprovalSignature({ ...signed, signature: "hmac-sha256:AAAAAAAAAAAAAAAAAAAA" }, TEST_ONLY_ED25519.publicKey)).toBe("SIGNATURE_INVALID");
  });

  it("[OPS-04] unsigned records and records without a trusted key are never valid", () => {
    const unsigned = baseRecord();
    expect(evaluateApproval(unsigned, { environment: "production", now: clock.now(), trustedKey: TEST_ONLY_ED25519.publicKey }).status).toBe("UNSIGNED");
    const signed = testOnlySign(baseRecord(), TEST_ONLY_ED25519.privateKey, "ed25519");
    expect(evaluateApproval(signed, { environment: "production", now: clock.now(), trustedKey: null }).status).toBe("UNVERIFIED_NO_TRUST_KEY");
  });

  it("[OPS-04] expired, not-yet-valid, wrong-environment and inverted-window records are rejected", () => {
    const k = TEST_ONLY_ED25519;
    const ev = (r: Partial<ApprovalRecord>) =>
      evaluateApproval(testOnlySign(baseRecord(r), k.privateKey, "ed25519"), { environment: "production", now: clock.now(), trustedKey: k.publicKey });
    expect(ev({ expiresAt: "2026-10-17T15:00:00.000Z" }).status).toBe("EXPIRED");
    expect(ev({ grantedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" }).status).toBe("NOT_YET_VALID");
    expect(ev({ environment: "staging" }).status).toBe("WRONG_ENVIRONMENT");
    expect(ev({ grantedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" }).status).toBe("INVALID_WINDOW");
    const both = ev({ environment: "sandbox", grantedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(both.failures).toEqual(["WRONG_ENVIRONMENT", "EXPIRED"]);
  });

  it("[OPS-04] only public keys of supported types are accepted as the trust anchor", () => {
    const pem = TEST_ONLY_ED25519.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(parseTrustedPublicKey(pem).type).toBe("public");
    const priv = TEST_ONLY_ED25519.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => parseTrustedPublicKey(priv)).toThrow("APPROVAL_TRUST_KEY_INVALID");
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => parseTrustedPublicKey(weak)).toThrow("APPROVAL_TRUST_KEY_INVALID");
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => parseTrustedPublicKey(p384)).toThrow("APPROVAL_TRUST_KEY_INVALID");
  });
});

describe("approval binding (OPS-APPR-01)", () => {
  const k = TEST_ONLY_ED25519;
  const modelRecord = (over: Partial<ApprovalRecord> = {}) =>
    testOnlySign(
      baseRecord({
        approvalId: "apr_TESTONLYmodel0001",
        scope: "MODEL_VOICE_SELECTION",
        approver: { name: "Test Only Approver", role: "qa_language_lead" },
        subject: { modelVoice: { model: "m-1", voice: "v-1", agentConfig: "a-1" } },
        ...over,
      }),
      k.privateKey,
      "ed25519",
    );
  const ctx = (expected?: ApprovalSubjectExpectations) => ({ environment: "production" as const, now: clock.now(), trustedKey: k.publicKey, expected });

  it("[OPS-04][OPS-APPR-01] the subject is covered by the signature (editing it after signing invalidates the record)", () => {
    const signed = modelRecord();
    expect(verifyApprovalSignature(signed, k.publicKey)).toBe("VERIFIED");
    expect(verifyApprovalSignature({ ...signed, subject: { modelVoice: { model: "m-9", voice: "v-1", agentConfig: "a-1" } } }, k.publicKey)).toBe("SIGNATURE_INVALID");
  });

  it("[OPS-04][OPS-APPR-01] a subject-bound record is VALID only for the exact artifact it names, and never when the caller cannot state it", () => {
    expect(evaluateApproval(modelRecord(), ctx({ modelVoice: { model: "m-1", voice: "v-1", agentConfig: "a-1" } })).status).toBe("VALID");
    expect(evaluateApproval(modelRecord(), ctx({ modelVoice: { model: "m-2", voice: "v-1", agentConfig: "a-1" } })).status).toBe("SUBJECT_MISMATCH");
    expect(evaluateApproval(modelRecord(), ctx()).status).toBe("SUBJECT_UNVERIFIABLE");
    expect(evaluateApproval(modelRecord({ subject: undefined }), ctx({ modelVoice: { model: "m-1", voice: "v-1", agentConfig: "a-1" } })).status).toBe("SUBJECT_MISSING");
    for (const scope of Object.keys(SUBJECT_KIND_BY_SCOPE) as ApprovalScope[]) {
      const role = APPROVER_ROLES_BY_SCOPE[scope][0];
      if (!role) throw new Error("no role");
      const r = testOnlySign(baseRecord({ scope, approver: { name: "Test Only Approver", role } }), k.privateKey, "ed25519");
      expect(evaluateApproval(r, ctx()).status, scope).toBe("SUBJECT_MISSING");
    }
  });

  it("[OPS-04][OPS-APPR-01] every scope has an allowed-role list and other roles are refused", () => {
    for (const scope of Object.keys(APPROVER_ROLES_BY_SCOPE) as ApprovalScope[]) expect(APPROVER_ROLES_BY_SCOPE[scope].length, scope).toBeGreaterThan(0);
    const vendor = testOnlySign(baseRecord({ scope: "PHI_PROCESSING", approver: { name: "Test Only Vendor", role: "talkdesk_admin" } }), k.privateKey, "ed25519");
    expect(evaluateApproval(vendor, ctx()).failures).toEqual(["APPROVER_ROLE_NOT_PERMITTED"]);
    const counsel = testOnlySign(baseRecord({ scope: "PHI_PROCESSING", approver: { name: "Test Only Counsel", role: "privacy_counsel" } }), k.privateKey, "ed25519");
    expect(evaluateApproval(counsel, ctx()).status).toBe("VALID");
  });
});

describe("approval record loading", () => {
  it("[OPS-04] the repository approvals directory contains no approval records (the coding agent cannot create them)", () => {
    const loaded = loadApprovalRecords(join(REPO_ROOT, "approvals"));
    expect(loaded.records).toEqual([]);
    expect(loaded.rejected).toEqual([]);
  });

  it("[OPS-04] approvals/schema/ApprovalRecord.schema.json is an exact copy of the protocol schema", () => {
    const a = readFileSync(join(REPO_ROOT, "approvals/schema/ApprovalRecord.schema.json"), "utf8");
    const b = readFileSync(join(REPO_ROOT, "schemas/protocol/ApprovalRecord.schema.json"), "utf8");
    expect(a).toBe(b);
  });

  it("[OPS-04] strictly parses records, reports malformed, oversized and duplicate files, ignores subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-approvals-test-"));
    const good = testOnlySign(baseRecord(), TEST_ONLY_ED25519.privateKey, "ed25519");
    writeFileSync(join(dir, "a-good.json"), JSON.stringify(good));
    writeFileSync(join(dir, "b-duplicate.json"), JSON.stringify(good));
    writeFileSync(join(dir, "c-extra-field.json"), JSON.stringify({ ...good, approvedByAgent: true }));
    writeFileSync(join(dir, "d-not-json.json"), "{nope");
    writeFileSync(join(dir, "e-huge.json"), JSON.stringify({ pad: "x".repeat(70_000) }));
    writeFileSync(join(dir, "README.md"), "# not a record");
    mkdirSync(join(dir, "schema"));
    writeFileSync(join(dir, "schema", "ApprovalRecord.schema.json"), "{}");
    const loaded = loadApprovalRecords(dir);
    expect(loaded.records.map((r) => r.approvalId)).toEqual([good.approvalId, good.approvalId]);
    expect(loaded.duplicateIds).toEqual([good.approvalId]);
    expect(loaded.rejected).toEqual([
      { file: "c-extra-field.json", reasonCode: "APPROVAL_RECORD_MALFORMED" },
      { file: "d-not-json.json", reasonCode: "APPROVAL_RECORD_MALFORMED" },
      { file: "e-huge.json", reasonCode: "APPROVAL_RECORD_TOO_LARGE" },
    ]);
  });

  it("[OPS-04] a missing approvals directory yields no approvals (fail closed)", () => {
    expect(loadApprovalRecords(join(tmpdir(), "vsp-does-not-exist-approvals")).records).toEqual([]);
  });
});

describe("trusted key resolution by reference", () => {
  it("[OPS-04] file resolver (LOCAL FIXTURE) loads a PEM public key and refuses path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-trust-key-test-"));
    writeFileSync(join(dir, "trusted.pem"), TEST_ONLY_P256.publicKey.export({ type: "spki", format: "pem" }).toString());
    const r = new FileTrustedKeyResolver(dir);
    expect(r.kind).toBe("local_fixture");
    expect((await r.resolve("file:trusted.pem"))?.asymmetricKeyType).toBe("ec");
    await expect(r.resolve("file:../etc/passwd")).rejects.toThrow("APPROVAL_TRUST_KEY_REF_INVALID");
    await expect(r.resolve("file:missing.pem")).rejects.toThrow("APPROVAL_TRUST_KEY_UNREADABLE");
    expect(await r.resolve("arn:aws:kms:us-east-1:111122223333:key/abc")).toBeNull();
  });

  it("[OPS-04] KMS resolver uses GetPublicKey (fixture client, no network) and accepts only SIGN_VERIFY keys", async () => {
    const der = TEST_ONLY_P256.publicKey.export({ type: "spki", format: "der" });
    const sent: unknown[] = [];
    const fixtureClient = (usage: string) => ({
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { PublicKey: new Uint8Array(der), KeySpec: "ECC_NIST_P256", KeyUsage: usage };
      },
    });
    const arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000";
    const ok = new KmsTrustedKeyResolver(fixtureClient("SIGN_VERIFY"), (input) => ({ fixtureCommand: "GetPublicKey", ...input }));
    expect(ok.kind).toBe("live");
    const key = await ok.resolve(arn);
    expect(key?.asymmetricKeyType).toBe("ec");
    expect(sent).toEqual([{ fixtureCommand: "GetPublicKey", KeyId: arn }]);
    const wrongUsage = new KmsTrustedKeyResolver(fixtureClient("ENCRYPT_DECRYPT"), (input) => input);
    await expect(wrongUsage.resolve(arn)).rejects.toThrow("APPROVAL_TRUST_KEY_INVALID");
    expect(await ok.resolve("file:trusted.pem")).toBeNull();
    const failing = new KmsTrustedKeyResolver({ send: async () => Promise.reject(new Error("network")) }, (i) => i);
    await expect(failing.resolve(arn)).rejects.toThrow("APPROVAL_TRUST_KEY_UNAVAILABLE");
  });
});
