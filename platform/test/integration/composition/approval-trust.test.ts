/**
 * Layer 2 (WP-07; FO-14-56, OPS-04, AUTH-02): the approval trust anchor of the live composition on the real
 * protocol. buildLiveContainer composes KmsTrustedKeyResolver as its ONLY key resolver, over the KMS client of
 * `infrastructure.aws` (LocalStack through the sandbox endpoint override): GetPublicKey returns the SPKI key, its
 * KeyUsage must be SIGN_VERIFY, and every approval record must verify against it.
 *
 * Covered: an ApprovalRecord signed with KMS Sign (ECDSA_SHA_256 over the canonical record) verifies and
 * satisfies the required scope; a record edited after signing does not; a record signed by a foreign KMS key,
 * an ENCRYPT_DECRYPT key as the anchor, a local PEM key (`file:`) in the sandbox profile even with a record that
 * verifies against that PEM, and a KMS key pending deletion are each refused; nothing is ever "approved for now".
 *
 * Key separation (FO-14-56, AUTH-02, FT-91): the runtime holds kms:Sign on its assertion key, so that key (or an
 * audit manifest key, or a runtime key of another committed environment) is never the trust anchor: the
 * environment is refused (APPROVAL_TRUST_KEY_IS_ASSERTION_KEY / _IS_MANIFEST_KEY) and the anchor is not used, so a
 * record minted through the runtime's own KmsAssertionSigner is never VALID. The audit manifest key is never the
 * assertion key and the console session sealer is never a pepper (compared by key id: an ARN matches its bare id).
 * Key material is compared for every form the runtime signs with: a manifest key named by its BARE key id is
 * resolved by GetPublicKey (KmsRuntimeSigningKeyResolver), so imported material equal to the assertion key's or the
 * anchor's is refused; a runtime signing key whose GetPublicKey is refused fails closed (RUNTIME_SIGNING_KEY_UNRESOLVED).
 */
import { constants, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes, sign as cryptoSign } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { CreateKeyCommand, GetParametersForImportCommand, GetPublicKeyCommand, ImportKeyMaterialCommand, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { KmsTrustedKeyResolver, approvalSigningPayload, evaluateApproval } from "../../../src/config/approvals.js";
import type { KmsPublicKeyClient } from "../../../src/config/approvals.js";
import { KmsAssertionSigner } from "../../../src/identity/assertions/signers.js";
import type { ApprovalRecord } from "../../../src/protocol/index.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { SUBSTRATE, bootLive, createKmsKey, createSecretValue, kmsSignedApproval, provisionSandbox, refusal } from "./support.js";
import type { Sandbox } from "./support.js";

const it = layer2([...SUBSTRATE]);
const SCOPE = "VENDOR_SANDBOX_INTEGRATION" as const;

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

/** JOSE ES256 signature (r || s, 32 bytes each) to the DER form approval records carry. */
function joseToDer(sig: Uint8Array): Buffer {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = Buffer.from(b.subarray(i));
    if ((v[0] ?? 0) & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(sig.subarray(0, 32));
  const s = int(sig.subarray(32, 64));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

/**
 * A SECURITY_REVIEW record minted the way a compromised gateway task could: through the PRODUCTION
 * KmsAssertionSigner over the runtime's own assertion key (the role is self-declared in the record).
 */
async function runtimeMintedApproval(o: { environment?: "sandbox" | "staging"; keyArn?: string } = {}): Promise<ApprovalRecord> {
  const now = Date.now();
  const unsigned: ApprovalRecord = {
    approvalId: `apr_synth${randomBytes(8).toString("hex")}`,
    approver: { name: "Not A Human (runtime-minted, Layer 2)", role: "security_leadership" },
    scope: "SECURITY_REVIEW",
    scopeDetail: "SYNTHETIC record minted by the runtime's own assertion signer: must never count.",
    environment: o.environment ?? "sandbox",
    grantedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    evidenceRef: "evidence://synthetic/layer2/runtime-minted",
    signature: null,
  };
  const jose = await new KmsAssertionSigner(sb.kms, o.keyArn ?? sb.keys.assertion).sign(new Uint8Array(Buffer.from(approvalSigningPayload(unsigned), "utf8")));
  return { ...unsigned, signature: `ecdsa-p256-sha256:${joseToDer(jose).toString("base64")}` };
}

const keyIdOf = (arn: string) => arn.slice(arn.indexOf(":key/") + 5);

/**
 * Two KMS keys (two key ids) holding the SAME imported P-256 key material (KMS ImportKeyMaterial, Origin EXTERNAL),
 * as a key administrator could create them. SYNTHETIC key material generated here for this test only.
 */
async function sameMaterialKeys(): Promise<[string, string]> {
  const material = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" });
  const arns: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await sb.kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Origin: "EXTERNAL", Description: "vsp-it-composition-imported" }));
    const keyId = created.KeyMetadata?.KeyId;
    const arn = created.KeyMetadata?.Arn;
    if (!keyId || !arn) throw new Error("LOCALSTACK_KMS_NO_KEY");
    const params = await sb.kms.send(new GetParametersForImportCommand({ KeyId: keyId, WrappingAlgorithm: "RSAES_OAEP_SHA_256", WrappingKeySpec: "RSA_2048" }));
    if (!params.PublicKey || !params.ImportToken) throw new Error("LOCALSTACK_KMS_NO_IMPORT_PARAMETERS");
    const wrapping = createPublicKey({ key: Buffer.from(params.PublicKey), format: "der", type: "spki" });
    const wrapped = publicEncrypt({ key: wrapping, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, material);
    await sb.kms.send(new ImportKeyMaterialCommand({ KeyId: keyId, ImportToken: params.ImportToken, EncryptedKeyMaterial: wrapped, ExpirationModel: "KEY_MATERIAL_DOES_NOT_EXPIRE" }));
    arns.push(arn);
  }
  return [arns[0] ?? "", arns[1] ?? ""];
}

/** Requires the scope and anchors trust on `trustRef`; approvals directory reset to `records`. */
function requireScope(trustRef: string, records: Parameters<Sandbox["writeApproval"]>[0][]): void {
  sb.clearApprovals();
  for (const r of records) sb.writeApproval(r);
  const cfg = sb.config();
  cfg.approvals.required = [SCOPE];
  cfg.approvals.trustedSigningKeyRef = trustRef;
  sb.writeConfig(cfg);
}

describe("approval trust anchor: KMS GetPublicKey over LocalStack [FO-14-56]", () => {
  it("[FO-14-56][OPS-04] positive: an approval record signed with KMS Sign verifies against the KMS public key and satisfies the required scope; a record edited after signing does not count", async () => {
    const good = await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: SCOPE });
    const edited = { ...(await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: SCOPE })), scopeDetail: "SYNTHETIC record edited after it was signed: must not verify." };
    requireScope(sb.keys.trust, [good, edited]);
    const { c } = await bootLive(sb);
    try {
      expect(c.report.deployable).toBe(true);
      const byId = Object.fromEntries(c.report.approvals.map((a) => [a.approvalId, a.status]));
      expect(byId[good.approvalId]).toBe("VALID");
      expect(byId[edited.approvalId]).toBe("SIGNATURE_INVALID");
      expect(good.signature).toMatch(/^ecdsa-p256-sha256:/);
    } finally {
      await c.close();
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial: a record signed with a foreign KMS key is refused (APPROVAL_MISSING, SIGNATURE_INVALID)", async () => {
    const foreign = await createKmsKey(sb.kms);
    const record = await kmsSignedApproval(sb.kms, foreign, { scope: SCOPE });
    requireScope(sb.keys.trust, [record]);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(expect.arrayContaining([`APPROVAL_MISSING@approvals.required.${SCOPE}`, `APPROVAL_SIGNATURE_INVALID@approvals.records.${record.approvalId}`]));
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][OPS-04] adversarial: an ENCRYPT_DECRYPT key is never a trust anchor (KeyUsage checked on GetPublicKey); the environment is refused", async () => {
    const enc = await createKmsKey(sb.kms, { usage: "ENCRYPT_DECRYPT", spec: "RSA_2048" });
    const record = await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: SCOPE });
    requireScope(enc, [record]);
    const memory = createMemoryLogger();
    try {
      const v = await refusal(bootLive(sb, { memory }));
      expect(v).toEqual(expect.arrayContaining(["APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef", `APPROVAL_MISSING@approvals.required.${SCOPE}`]));
      expect(memory.records.find((r) => r.event === "config.approval_key.unresolved")?.fields).toMatchObject({ reasonCode: "APPROVAL_TRUST_KEY_INVALID", kind: "live" });
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][FO-14-53] adversarial: a local PEM key in the sandbox profile is refused even when the record verifies against it (APPROVAL_TRUST_KEY_REF_NOT_KMS)", async () => {
    // A self-made anchor: the exact shape a demo would use to approve itself.
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    mkdirSync(join(sb.repoRoot, "keys"), { recursive: true });
    writeFileSync(join(sb.repoRoot, "keys", "trust.pem"), publicKey.export({ type: "spki", format: "pem" }).toString());
    const unsigned = { ...(await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: SCOPE })), signature: null };
    const record = { ...unsigned, signature: `ecdsa-p256-sha256:${cryptoSign("sha256", Buffer.from(approvalSigningPayload(unsigned), "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64")}` };
    requireScope("file:keys/trust.pem", [record]);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(expect.arrayContaining(["APPROVAL_TRUST_KEY_REF_NOT_KMS@approvals.trustedSigningKeyRef", "APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef", `APPROVAL_MISSING@approvals.required.${SCOPE}`]));
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][OPS-01] failure injection: the anchor key pending deletion in KMS (GetPublicKey refused) fails closed: no approval counts and the environment is refused", async () => {
    const anchor = await createKmsKey(sb.kms);
    const record = await kmsSignedApproval(sb.kms, anchor, { scope: SCOPE });
    // Fidelity: LocalStack 4.14 still answers GetPublicKey for a DISABLED key (AWS refuses it); a key pending
    // deletion is refused by both, so the injection uses ScheduleKeyDeletion.
    await sb.kms.send(new ScheduleKeyDeletionCommand({ KeyId: anchor, PendingWindowInDays: 7 }));
    requireScope(anchor, [record]);
    const memory = createMemoryLogger();
    try {
      const v = await refusal(bootLive(sb, { memory }));
      expect(v).toEqual(expect.arrayContaining(["APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef", `APPROVAL_MISSING@approvals.required.${SCOPE}`]));
      expect(memory.records.find((r) => r.event === "config.approval_key.unresolved")?.fields).toMatchObject({ kind: "live" });
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor equal to the runtime assertion key refuses the environment (APPROVAL_TRUST_KEY_IS_ASSERTION_KEY), and a SECURITY_REVIEW record minted through the runtime's KmsAssertionSigner is never VALID", async () => {
    const minted = await runtimeMintedApproval();
    sb.clearApprovals();
    sb.writeApproval(minted);
    const cfg = sb.config();
    cfg.approvals.required = ["SECURITY_REVIEW"];
    cfg.approvals.trustedSigningKeyRef = sb.keys.assertion;
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining([
          "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@approvals.trustedSigningKeyRef",
          "APPROVAL_MISSING@approvals.required.SECURITY_REVIEW",
          // The anchor is not used at all: the runtime-minted record, correctly signed for that key, does not verify.
          `APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${minted.approvalId}`,
        ]),
      );
      expect(v).not.toContain("APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef");
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] control: with a separate anchor the gateway starts and the runtime-minted record is SIGNATURE_INVALID (never VALID); requiring its scope refuses the environment", async () => {
    const minted = await runtimeMintedApproval();
    sb.clearApprovals();
    sb.writeApproval(minted);
    try {
      const { c } = await bootLive(sb);
      try {
        expect(c.report.deployable).toBe(true);
        expect(c.report.approvals.find((a) => a.approvalId === minted.approvalId)?.status).toBe("SIGNATURE_INVALID");
      } finally {
        await c.close();
      }
      const cfg = sb.config();
      cfg.approvals.required = ["SECURITY_REVIEW"];
      sb.writeConfig(cfg);
      expect(await refusal(bootLive(sb))).toEqual(expect.arrayContaining(["APPROVAL_MISSING@approvals.required.SECURITY_REVIEW", `APPROVAL_SIGNATURE_INVALID@approvals.records.${minted.approvalId}`]));
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor equal to the runtime assertion key of ANOTHER committed environment configuration refuses the environment", async () => {
    const other = join(sb.configDir, "staging.json");
    writeFileSync(other, JSON.stringify({ environment: "staging", signing: { assertionKeyRef: sb.keys.trust, localDevKey: false } }));
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toContain("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@environments.staging.signing.assertionKeyRef");
      // The violation names configuration paths only, never a key.
      expect(v.join(" ")).not.toMatch(/arn:aws|[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      rmSync(other, { force: true });
    }
    const { c } = await bootLive(sb);
    await c.close();
  });

  it("[AUTH-02][OPS-01] adversarial: the audit manifest key equal to the assertion key (by its bare key id), the trust anchor among the trusted manifest keys, and the console sealer equal to the request-hash pepper each refuse the environment", async () => {
    const exporter = await createSecretValue(sb.sm, "keysep-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifier = await createSecretValue(sb.sm, "keysep-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    const cfg = sb.config();
    cfg.infrastructure.auditExport = { manifestSigningKeyId: keyIdOf(sb.keys.assertion), exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [keyIdOf(sb.keys.assertion), keyIdOf(sb.keys.trust)] };
    cfg.infrastructure.secrets.consoleSessionSealerRef = sb.refs.pepper;
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining([
          "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.manifestSigningKeyId",
          "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.trustedManifestKeyIds.0",
          "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY@approvals.trustedSigningKeyRef",
          "SECRET_REUSED_ACROSS_PURPOSES@infrastructure.secrets.consoleSessionSealerRef",
        ]),
      );
      // Control: separate keys and secrets for each purpose boot, and the independent audit capability is CONFIGURED.
      const manifest = await createKmsKey(sb.kms);
      const ok = sb.config();
      ok.infrastructure.auditExport = { manifestSigningKeyId: manifest, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [manifest] };
      sb.writeConfig(ok);
      const { c } = await bootLive(sb);
      try {
        expect(c.report.deployable).toBe(true);
        expect(c.activation.state("audit.independent")).toBe("CONFIGURED");
      } finally {
        await c.close();
      }
    } finally {
      sb.writeConfig(sb.config());
    }
  });
  it("[AUTH-02][DATA-01] adversarial: every secret serves one purpose: the console sealer equal to the runtime database login (also by its partial ARN) or to the audit exporter login, and the request-hash pepper equal to the database login, each refuse the environment", async () => {
    const exporter = await createSecretValue(sb.sm, "keysep-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifier = await createSecretValue(sb.sm, "keysep-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    const manifest = await createKmsKey(sb.kms);
    const partial = sb.refs.database.replace(/-[A-Za-z0-9]{6}$/, "");
    expect(partial).not.toBe(sb.refs.database);
    const cases: [string, (cfg: ReturnType<Sandbox["config"]>) => void, string][] = [
      ["sealer == database login", (cfg) => void (cfg.infrastructure.secrets.consoleSessionSealerRef = sb.refs.database), "SECRET_REUSED_ACROSS_PURPOSES@infrastructure.secrets.consoleSessionSealerRef"],
      ["sealer == database login (partial ARN)", (cfg) => void (cfg.infrastructure.secrets.consoleSessionSealerRef = partial), "SECRET_REUSED_ACROSS_PURPOSES@infrastructure.secrets.consoleSessionSealerRef"],
      [
        "sealer == audit exporter login",
        (cfg) => {
          cfg.infrastructure.auditExport = { manifestSigningKeyId: manifest, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [manifest] };
          cfg.infrastructure.secrets.consoleSessionSealerRef = exporter;
        },
        "SECRET_REUSED_ACROSS_PURPOSES@infrastructure.auditExport.exporterDatabaseRef",
      ],
      ["request-hash pepper == database login", (cfg) => void (cfg.infrastructure.secrets.requestHashPepperRef = sb.refs.database), "SECRET_REUSED_ACROSS_PURPOSES@infrastructure.secrets.requestHashPepperRef"],
    ];
    try {
      for (const [label, mutate, expected] of cases) {
        const cfg = sb.config();
        mutate(cfg);
        sb.writeConfig(cfg);
        const v = await refusal(bootLive(sb));
        expect(v, label).toContain(expected);
        expect(v.join(" "), label).not.toMatch(/arn:aws|postgres:/);
      }
    } finally {
      sb.writeConfig(sb.config());
    }
    // Control: the same audit export with its own logins and a separate sealer boots.
    const ok = sb.config();
    ok.infrastructure.auditExport = { manifestSigningKeyId: manifest, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [manifest] };
    sb.writeConfig(ok);
    try {
      const { c } = await bootLive(sb);
      await c.close();
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial (reverse direction): a sandbox runtime whose assertion key (through the allowlisted override) is the approval trust anchor of the committed staging configuration is refused; that runtime's signer could mint a staging approval that verifies", async () => {
    const stagingAnchor = await createKmsKey(sb.kms);
    const stagingAssertion = await createKmsKey(sb.kms);
    const other = join(sb.configDir, "staging.json");
    writeFileSync(other, JSON.stringify({ environment: "staging", signing: { assertionKeyRef: stagingAssertion, localDevKey: false }, approvals: { directory: "approvals", required: ["SECURITY_REVIEW"], trustedSigningKeyRef: stagingAnchor } }));
    try {
      // Why it must be refused: through the PRODUCTION signer over that key, a staging SECURITY_REVIEW record
      // verifies against staging's anchor (staging's own guard reads only the committed sandbox file).
      const minted = await runtimeMintedApproval({ environment: "staging", keyArn: stagingAnchor });
      const anchorKey = await new KmsTrustedKeyResolver(sb.kms as unknown as KmsPublicKeyClient, (input) => new GetPublicKeyCommand(input)).resolve(stagingAnchor);
      expect(evaluateApproval(minted, { environment: "staging", now: new Date(), trustedKey: anchorKey, expected: {} as never }).status).toBe("VALID");
      const v = await refusal(bootLive(sb, { env: { VSP_CONFIG_ASSERTION_KEY_REF: stagingAnchor } }));
      expect(v).toContain("ASSERTION_KEY_IS_APPROVAL_TRUST_KEY@environments.staging.approvals.trustedSigningKeyRef");
      expect(v.join(" ")).not.toMatch(/arn:aws|[0-9a-f]{8}-[0-9a-f]{4}-/);
      // The sandbox's own trust anchor is not the problem: it is not refused as an anchor.
      expect(v.filter((x) => x.startsWith("APPROVAL_TRUST_KEY_IS_"))).toEqual([]);
      // Control: the committed sandbox assertion key, with the same staging file present, boots.
      const { c } = await bootLive(sb);
      await c.close();
    } finally {
      rmSync(other, { force: true });
    }
  });

  it("[AUTH-02][FO-14-56] adversarial: a signing key or a secret shared with another committed environment configuration refuses the environment", async () => {
    const other = join(sb.configDir, "staging.json");
    writeFileSync(
      other,
      JSON.stringify({ environment: "staging", signing: { assertionKeyRef: sb.keys.assertion, localDevKey: false }, infrastructure: { secrets: { requestHashPepperRef: null, otpPepperRef: null, consoleSessionSealerRef: sb.refs.pepper } } }),
    );
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining(["SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS@environments.staging.signing.assertionKeyRef", "SECRET_REUSED_ACROSS_ENVIRONMENTS@environments.staging.infrastructure.secrets.consoleSessionSealerRef"]),
      );
      expect(v.join(" ")).not.toMatch(/arn:aws|[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      rmSync(other, { force: true });
    }
  });
  it("[FO-14-56][AUTH-02] adversarial: a trust anchor that is ANOTHER key id holding the assertion key's imported key material is refused by key material, and the runtime-minted record is never VALID", async () => {
    const [assertionKey, anchorKey] = await sameMaterialKeys();
    expect(keyIdOf(assertionKey)).not.toBe(keyIdOf(anchorKey));
    // Why it must be refused: the runtime's signer over its assertion key mints a record that verifies against the anchor.
    const minted = await runtimeMintedApproval({ keyArn: assertionKey });
    const anchorPublic = await new KmsTrustedKeyResolver(sb.kms as unknown as KmsPublicKeyClient, (input) => new GetPublicKeyCommand(input)).resolve(anchorKey);
    expect(evaluateApproval(minted, { environment: "sandbox", now: new Date(), trustedKey: anchorPublic, expected: {} as never }).status).toBe("VALID");
    sb.clearApprovals();
    sb.writeApproval(minted);
    const cfg = sb.config();
    cfg.approvals.required = ["SECURITY_REVIEW"];
    cfg.approvals.trustedSigningKeyRef = anchorKey;
    cfg.signing = { assertionKeyRef: assertionKey, localDevKey: false };
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining(["APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@approvals.trustedSigningKeyRef", "APPROVAL_MISSING@approvals.required.SECURITY_REVIEW", `APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${minted.approvalId}`]),
      );
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });
  it("[FO-14-56][AUTH-02] adversarial: an audit manifest key named by its BARE key id that holds the assertion key's imported key material is refused by material (GetPublicKey by bare id), as is its key ARN form", async () => {
    const [assertionKey, manifestKey] = await sameMaterialKeys();
    expect(keyIdOf(manifestKey)).not.toBe(keyIdOf(assertionKey));
    const exporter = await createSecretValue(sb.sm, "keysep-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifier = await createSecretValue(sb.sm, "keysep-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    try {
      for (const ref of [keyIdOf(manifestKey), manifestKey]) {
        const cfg = sb.config();
        cfg.signing = { assertionKeyRef: assertionKey, localDevKey: false };
        cfg.infrastructure.auditExport = { manifestSigningKeyId: ref, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [ref] };
        sb.writeConfig(cfg);
        const v = await refusal(bootLive(sb));
        expect(v, ref).toEqual(expect.arrayContaining(["AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.manifestSigningKeyId", "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.trustedManifestKeyIds.0"]));
        expect(v.filter((x) => x.startsWith("RUNTIME_SIGNING_KEY_UNRESOLVED")), ref).toEqual([]);
        expect(v.join(" "), ref).not.toMatch(/arn:aws|[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor holding the imported key material of an audit manifest key named by its BARE key id is refused; an approval minted with the manifest key (it verifies under the anchor) is never VALID", async () => {
    const [anchorKey, manifestKey] = await sameMaterialKeys();
    const manifestId = keyIdOf(manifestKey);
    const exporter = await createSecretValue(sb.sm, "keysep-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifier = await createSecretValue(sb.sm, "keysep-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    // Why it must be refused: the audit exporter's key mints a SECURITY_REVIEW record that verifies against the anchor.
    const minted = await runtimeMintedApproval({ keyArn: manifestId });
    const anchorPublic = await new KmsTrustedKeyResolver(sb.kms as unknown as KmsPublicKeyClient, (input) => new GetPublicKeyCommand(input)).resolve(anchorKey);
    expect(evaluateApproval(minted, { environment: "sandbox", now: new Date(), trustedKey: anchorPublic, expected: {} as never }).status).toBe("VALID");
    sb.clearApprovals();
    sb.writeApproval(minted);
    const cfg = sb.config();
    cfg.approvals.required = ["SECURITY_REVIEW"];
    cfg.approvals.trustedSigningKeyRef = anchorKey;
    cfg.infrastructure.auditExport = { manifestSigningKeyId: manifestId, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [manifestId] };
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(expect.arrayContaining(["APPROVAL_TRUST_KEY_IS_MANIFEST_KEY@approvals.trustedSigningKeyRef", "APPROVAL_MISSING@approvals.required.SECURITY_REVIEW", `APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${minted.approvalId}`]));
      // Control: a manifest key with its own material (by bare id) boots, and audit.independent is CONFIGURED.
      const own = keyIdOf(await createKmsKey(sb.kms));
      const ok = sb.config();
      ok.infrastructure.auditExport = { manifestSigningKeyId: own, exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [own] };
      sb.writeConfig(ok);
      const { c } = await bootLive(sb);
      try {
        expect(c.report.deployable).toBe(true);
        expect(c.activation.state("audit.independent")).toBe("CONFIGURED");
      } finally {
        await c.close();
      }
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][OPS-01] failure injection: GetPublicKey refused on an audit manifest key (pending deletion) while the anchor resolves refuses the environment (RUNTIME_SIGNING_KEY_UNRESOLVED, never only logged) and the anchor is not used", async () => {
    const manifest = await createKmsKey(sb.kms);
    await sb.kms.send(new ScheduleKeyDeletionCommand({ KeyId: manifest, PendingWindowInDays: 7 }));
    const exporter = await createSecretValue(sb.sm, "keysep-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifier = await createSecretValue(sb.sm, "keysep-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    const record = await kmsSignedApproval(sb.kms, sb.keys.trust, { scope: SCOPE });
    sb.clearApprovals();
    sb.writeApproval(record);
    const cfg = sb.config();
    cfg.approvals.required = [SCOPE];
    cfg.infrastructure.auditExport = { manifestSigningKeyId: keyIdOf(manifest), exporterDatabaseRef: exporter, verifierDatabaseRef: verifier, trustedManifestKeyIds: [keyIdOf(manifest)] };
    sb.writeConfig(cfg);
    const memory = createMemoryLogger();
    try {
      const v = await refusal(bootLive(sb, { memory }));
      expect(v).toEqual(
        expect.arrayContaining([
          "RUNTIME_SIGNING_KEY_UNRESOLVED@infrastructure.auditExport.manifestSigningKeyId",
          "RUNTIME_SIGNING_KEY_UNRESOLVED@infrastructure.auditExport.trustedManifestKeyIds.0",
          // The record is correctly signed for the anchor, but the anchor's separation is unproven: it is not used.
          `APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${record.approvalId}`,
        ]),
      );
      expect(v).not.toContain("APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef");
      expect(memory.records.find((r) => r.event === "config.runtime_signing_key.unresolved")?.fields).toMatchObject({ reasonCode: "RUNTIME_SIGNING_KEY_UNAVAILABLE", kind: "live", component: "infrastructure.auditExport.manifestSigningKeyId" });
    } finally {
      sb.clearApprovals();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-14-56][AUTH-02] adversarial: the anchor naming the assertion key by a replica ARN in another region (its public key not fetchable here) is still refused, by reference", async () => {
    const replica = sb.keys.assertion.replace(/^(arn:aws:kms:)[a-z0-9-]+(:)/, "$1us-west-2$2");
    expect(replica).not.toBe(sb.keys.assertion);
    const cfg = sb.config();
    cfg.approvals.trustedSigningKeyRef = replica;
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toContain("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@approvals.trustedSigningKeyRef");
      // The separation failure is the reason reported, not an unresolvable key.
      expect(v).not.toContain("APPROVAL_TRUST_KEY_UNRESOLVED@approvals.trustedSigningKeyRef");
    } finally {
      sb.writeConfig(sb.config());
    }
  });
});
