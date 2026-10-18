/**
 * Human approval records (spec sections 5 and 16).
 *
 * The coding agent cannot create approval records. Records are written by
 * accountable humans into `approvals/*.json` and carry a detached signature made
 * with a trusted asymmetric key (AWS KMS in staging/production). This module:
 *  - strictly parses each file against the protocol ApprovalRecord schema;
 *  - verifies the detached signature with node:crypto against the trusted PUBLIC
 *    key, which is supplied by reference (`approvals.trustedSigningKeyRef`);
 *  - evaluates environment, validity window and expiry against an injected time.
 * Without a trusted key every record is UNVERIFIED, which is invalid for any
 * environment that requires approvals.
 *
 * Signature format: `<algorithm>:<base64 signature>` over the UTF-8 bytes of
 * `approvalSigningPayload(record)` = canonical JSON (sorted keys, no whitespace)
 * of the record with the `signature` property removed. Algorithms:
 *   ed25519            Ed25519 (pure)
 *   ecdsa-p256-sha256  ECDSA P-256 / SHA-256, DER-encoded (KMS ECDSA_SHA_256)
 *   rsa-pss-sha256     RSASSA-PSS / SHA-256, salt length 32 (KMS RSASSA_PSS_SHA_256), modulus >= 2048 bits
 * The algorithm tag must match the trusted key type (no algorithm confusion).
 *
 * Binding (OPS-APPR-01): a valid signature is not enough. `evaluateApproval` also
 * requires (a) the approver role to be one allowed for the scope
 * (APPROVER_ROLES_BY_SCOPE) and (b) for scopes that approve a versioned artifact
 * (SUBJECT_KIND_BY_SCOPE) the signed `subject` member to EQUAL the artifact the
 * caller actually configured or loaded (`expected`). A caller that cannot say what
 * the artifact is gets SUBJECT_UNVERIFIABLE (fail closed), never VALID.
 */
import { constants, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ApprovalRecord } from "../protocol/index.js";
import type { ApprovalScope, ApprovalSubject, ApproverRole, Environment } from "../protocol/index.js";
import { canonicalJson } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";

export type SignatureAlgorithm = "ed25519" | "ecdsa-p256-sha256" | "rsa-pss-sha256";

export type SignatureStatus = "VERIFIED" | "UNVERIFIED_NO_TRUST_KEY" | "UNSIGNED" | "SIGNATURE_INVALID" | "SIGNATURE_ALGORITHM_MISMATCH";

export type ApprovalStatus =
  | "VALID"
  | Exclude<SignatureStatus, "VERIFIED">
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "INVALID_WINDOW"
  | "WRONG_ENVIRONMENT"
  /** approver.role is not allowed to sign this scope (APPROVER_ROLES_BY_SCOPE). */
  | "APPROVER_ROLE_NOT_PERMITTED"
  /** The scope approves a versioned artifact but the signed record names none. */
  | "SUBJECT_MISSING"
  /** The signed subject names a different artifact than the one configured/loaded. */
  | "SUBJECT_MISMATCH"
  /** The caller could not state the configured/loaded artifact, so the binding cannot be proven. */
  | "SUBJECT_UNVERIFIABLE"
  /** The subject carries a member that does not belong to the record's scope. */
  | "SUBJECT_UNEXPECTED";

/**
 * Scope -> approver roles allowed to sign it (spec sections 5/16: accountable humans
 * retain privacy, security, clinical, finance and release authority; approvals/README.md
 * "Who may create a record"). Changing this table is a reviewed code change; it is a
 * consistency check on the signed record and does not replace control of the signing
 * key (per-role keys are a security-leadership prerequisite, PRQ-023).
 */
export const APPROVER_ROLES_BY_SCOPE: Readonly<Record<ApprovalScope, readonly ApproverRole[]>> = {
  PHI_PROCESSING: ["privacy_counsel"],
  RETENTION_SCHEDULE: ["privacy_counsel"],
  SECURITY_REVIEW: ["security_leadership"],
  STATIC_CREDENTIAL_EXCEPTION: ["security_leadership"],
  CLINICAL_SCRIPTS: ["clinical_safety_lead"],
  BILLABLE_TEST_EXECUTION: ["finance"],
  PSTN_TEST_CALLS: ["executive_sponsor", "operations", "sre_lead"],
  PILOT_EXPOSURE: ["executive_sponsor", "operations", "sre_lead"],
  PRODUCTION_DEPLOYMENT: ["executive_sponsor", "operations", "sre_lead"],
  VENDOR_SANDBOX_INTEGRATION: ["talkdesk_admin", "salesforce_admin", "identity_owner"],
  MODEL_VOICE_SELECTION: ["qa_language_lead", "clinical_safety_lead", "security_leadership"],
  KNOWLEDGE_RELEASE: ["qa_language_lead", "clinical_safety_lead", "security_leadership"],
  POLICY_RELEASE: ["qa_language_lead", "clinical_safety_lead", "security_leadership"],
};

export type ApprovalSubjectKind = keyof ApprovalSubject;

/** Scopes that approve one exact, versioned artifact and the subject member that names it. */
export const SUBJECT_KIND_BY_SCOPE: Readonly<Partial<Record<ApprovalScope, ApprovalSubjectKind>>> = {
  MODEL_VOICE_SELECTION: "modelVoice",
  POLICY_RELEASE: "policyBundle",
  KNOWLEDGE_RELEASE: "knowledgeSnapshotDigest",
  CLINICAL_SCRIPTS: "templateCatalogDigest",
  PRODUCTION_DEPLOYMENT: "release",
  PILOT_EXPOSURE: "release",
};

/**
 * What the caller actually configured or loaded. `undefined`/`null` means "not known
 * to this caller" and makes a subject-bound scope SUBJECT_UNVERIFIABLE. For the policy
 * bundle, `version: null` compares the digest only (the release manifest records the
 * bundle digest, not its version label).
 */
export interface ApprovalSubjectExpectations {
  modelVoice?: { model: string; voice: string; agentConfig: string } | null;
  policyBundle?: { version: string | null; digest: string } | null;
  knowledgeSnapshotDigest?: string | null;
  templateCatalogDigest?: string | null;
  releaseImageDigest?: string | null;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const UNPINNED_LABEL = /^(UNPINNED|UNKNOWN)$/;

/**
 * Expectations for a ReleaseManifest (deploy gate and manifest builder): model / voice /
 * agentConfig = versions.*, policy = policyBundleDigest (digest only; versions.policyBundle
 * is a label derived from it), knowledge = knowledgeSnapshotDigest, templates =
 * versions.promptTemplates when it is a sha256 digest, image = build.imageDigest.
 * Unpinned or absent values become null (=> SUBJECT_UNVERIFIABLE, fail closed).
 */
export function releaseSubjectExpectations(m: {
  versions: { model: string; voice: string; agentConfig: string; promptTemplates: string };
  policyBundleDigest: string | null;
  knowledgeSnapshotDigest: string | null;
  build: { imageDigest: string | null };
}): ApprovalSubjectExpectations {
  const v = m.versions;
  const pinned = [v.model, v.voice, v.agentConfig].every((x) => !UNPINNED_LABEL.test(x));
  return {
    modelVoice: pinned ? { model: v.model, voice: v.voice, agentConfig: v.agentConfig } : null,
    policyBundle: m.policyBundleDigest && SHA256_HEX.test(m.policyBundleDigest) ? { version: null, digest: m.policyBundleDigest } : null,
    knowledgeSnapshotDigest: m.knowledgeSnapshotDigest && SHA256_HEX.test(m.knowledgeSnapshotDigest) ? m.knowledgeSnapshotDigest : null,
    templateCatalogDigest: SHA256_HEX.test(v.promptTemplates) ? v.promptTemplates : null,
    releaseImageDigest: m.build.imageDigest && /^sha256:[a-f0-9]{64}$/.test(m.build.imageDigest) ? m.build.imageDigest : null,
  };
}

type SubjectFailure = "SUBJECT_MISSING" | "SUBJECT_MISMATCH" | "SUBJECT_UNVERIFIABLE" | "SUBJECT_UNEXPECTED";

/** Subject binding check for one record; null when the record is bound (or its scope needs no subject). */
export function subjectBindingFailure(record: ApprovalRecord, expected: ApprovalSubjectExpectations | undefined): SubjectFailure | null {
  const kind = SUBJECT_KIND_BY_SCOPE[record.scope];
  const subject = record.subject;
  if (subject) {
    for (const k of Object.keys(subject) as ApprovalSubjectKind[]) if (subject[k] !== undefined && k !== kind) return "SUBJECT_UNEXPECTED";
  }
  if (!kind) return null;
  const e = expected ?? {};
  switch (kind) {
    case "modelVoice": {
      const s = subject?.modelVoice;
      if (!s) return "SUBJECT_MISSING";
      if (!e.modelVoice) return "SUBJECT_UNVERIFIABLE";
      return s.model === e.modelVoice.model && s.voice === e.modelVoice.voice && s.agentConfig === e.modelVoice.agentConfig ? null : "SUBJECT_MISMATCH";
    }
    case "policyBundle": {
      const s = subject?.policyBundle;
      if (!s) return "SUBJECT_MISSING";
      if (!e.policyBundle) return "SUBJECT_UNVERIFIABLE";
      if (s.digest !== e.policyBundle.digest) return "SUBJECT_MISMATCH";
      return e.policyBundle.version === null || s.version === e.policyBundle.version ? null : "SUBJECT_MISMATCH";
    }
    case "knowledgeSnapshotDigest": {
      const s = subject?.knowledgeSnapshotDigest;
      if (!s) return "SUBJECT_MISSING";
      if (!e.knowledgeSnapshotDigest) return "SUBJECT_UNVERIFIABLE";
      return s === e.knowledgeSnapshotDigest ? null : "SUBJECT_MISMATCH";
    }
    case "templateCatalogDigest": {
      const s = subject?.templateCatalogDigest;
      if (!s) return "SUBJECT_MISSING";
      if (!e.templateCatalogDigest) return "SUBJECT_UNVERIFIABLE";
      return s === e.templateCatalogDigest ? null : "SUBJECT_MISMATCH";
    }
    case "release": {
      const s = subject?.release;
      if (!s) return "SUBJECT_MISSING";
      if (!e.releaseImageDigest) return "SUBJECT_UNVERIFIABLE";
      return s.imageDigest === e.releaseImageDigest ? null : "SUBJECT_MISMATCH";
    }
  }
}

export interface ApprovalEvaluation {
  approvalId: string;
  scope: ApprovalScope;
  environment: Environment;
  /** VALID only when every check passed; otherwise the first failing check. */
  status: ApprovalStatus;
  /** Every failing check, in evaluation order. */
  failures: Exclude<ApprovalStatus, "VALID">[];
  expiresAt: string;
}

/** Canonical bytes a human approver signs (record without `signature`). */
export function approvalSigningPayload(record: ApprovalRecord): string {
  const { signature: _sig, ...unsigned } = record;
  return canonicalJson(unsigned);
}

/** Parses a trusted PUBLIC key (PEM / SPKI). Private and symmetric keys are refused. */
export function parseTrustedPublicKey(pem: string): KeyObject {
  if (typeof pem !== "string" || pem.length > 16_384 || !/-----BEGIN PUBLIC KEY-----/.test(pem) || /PRIVATE KEY/.test(pem)) {
    throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: "pem" });
  } catch {
    throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
  }
  if (key.type !== "public" || algorithmForKey(key) === null) throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
  return key;
}

export function algorithmForKey(key: KeyObject): SignatureAlgorithm | null {
  const t = key.asymmetricKeyType;
  if (t === "ed25519") return "ed25519";
  if (t === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ecdsa-p256-sha256";
  if ((t === "rsa" || t === "rsa-pss") && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) return "rsa-pss-sha256";
  return null;
}

const SIGNATURE_FORMAT = /^(ed25519|ecdsa-p256-sha256|rsa-pss-sha256):([A-Za-z0-9+/]+={0,2})$/;

export function verifyApprovalSignature(record: ApprovalRecord, trustedKey: KeyObject | null): SignatureStatus {
  if (record.signature === null) return "UNSIGNED";
  if (!trustedKey) return "UNVERIFIED_NO_TRUST_KEY";
  const m = SIGNATURE_FORMAT.exec(record.signature);
  if (!m) return "SIGNATURE_INVALID";
  const alg = m[1] as SignatureAlgorithm;
  const sig = Buffer.from(m[2] ?? "", "base64");
  if (algorithmForKey(trustedKey) !== alg) return "SIGNATURE_ALGORITHM_MISMATCH";
  const data = Buffer.from(approvalSigningPayload(record), "utf8");
  try {
    let ok = false;
    if (alg === "ed25519") ok = cryptoVerify(null, data, trustedKey, sig);
    else if (alg === "ecdsa-p256-sha256") ok = cryptoVerify("sha256", data, { key: trustedKey, dsaEncoding: "der" }, sig);
    else ok = cryptoVerify("sha256", data, { key: trustedKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    return ok ? "VERIFIED" : "SIGNATURE_INVALID";
  } catch {
    return "SIGNATURE_INVALID";
  }
}

export function evaluateApproval(
  record: ApprovalRecord,
  ctx: {
    environment: Environment;
    now: Date;
    trustedKey: KeyObject | null;
    /** Configured/loaded artifacts the record must be bound to (OPS-APPR-01). Absent: subject-bound scopes are SUBJECT_UNVERIFIABLE. */
    expected?: ApprovalSubjectExpectations;
  },
): ApprovalEvaluation {
  const failures: Exclude<ApprovalStatus, "VALID">[] = [];
  const sig = verifyApprovalSignature(record, ctx.trustedKey);
  if (sig !== "VERIFIED") failures.push(sig);
  if (record.environment !== ctx.environment) failures.push("WRONG_ENVIRONMENT");
  const granted = Date.parse(record.grantedAt);
  const expires = Date.parse(record.expiresAt);
  const now = ctx.now.getTime();
  if (!(Number.isFinite(granted) && Number.isFinite(expires)) || expires <= granted) failures.push("INVALID_WINDOW");
  else {
    if (now < granted) failures.push("NOT_YET_VALID");
    if (now >= expires) failures.push("EXPIRED");
  }
  if (!(APPROVER_ROLES_BY_SCOPE[record.scope] ?? []).includes(record.approver.role)) failures.push("APPROVER_ROLE_NOT_PERMITTED");
  const subject = subjectBindingFailure(record, ctx.expected);
  if (subject) failures.push(subject);
  return {
    approvalId: record.approvalId,
    scope: record.scope,
    environment: record.environment,
    status: failures[0] ?? "VALID",
    failures,
    expiresAt: record.expiresAt,
  };
}

export interface LoadedApprovals {
  records: ApprovalRecord[];
  /** Files that exist but failed strict parsing; they never count as approvals. */
  rejected: { file: string; reasonCode: "APPROVAL_RECORD_MALFORMED" | "APPROVAL_RECORD_TOO_LARGE" | "APPROVAL_RECORD_UNREADABLE" }[];
  /** Duplicate approvalIds across files (suspicious; both copies are reported). */
  duplicateIds: string[];
}

const MAX_APPROVAL_FILE_BYTES = 64 * 1024;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}\.json$/;

/**
 * Loads `<dir>/*.json` (top level only; `schema/` and README are ignored).
 * A missing directory yields no records (fail closed: nothing is approved).
 */
export function loadApprovalRecords(dir: string): LoadedApprovals {
  const out: LoadedApprovals = { records: [], rejected: [], duplicateIds: [] };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = SAFE_FILE.test(name) ? name : "unsafe-file-name";
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_APPROVAL_FILE_BYTES) {
        out.rejected.push({ file, reasonCode: "APPROVAL_RECORD_TOO_LARGE" });
        continue;
      }
    } catch {
      out.rejected.push({ file, reasonCode: "APPROVAL_RECORD_UNREADABLE" });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      out.rejected.push({ file, reasonCode: "APPROVAL_RECORD_MALFORMED" });
      continue;
    }
    const parsed = ApprovalRecord.safeParse(raw);
    if (!parsed.success) {
      out.rejected.push({ file, reasonCode: "APPROVAL_RECORD_MALFORMED" });
      continue;
    }
    if (seen.has(parsed.data.approvalId)) out.duplicateIds.push(parsed.data.approvalId);
    seen.add(parsed.data.approvalId);
    out.records.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trusted key resolution (key supplied by reference)
// ---------------------------------------------------------------------------

export interface TrustedKeyResolver {
  readonly kind: "local_fixture" | "live";
  /** Resolves `approvals.trustedSigningKeyRef` to a public key; null when the reference is not supported. */
  resolve(ref: string): Promise<KeyObject | null>;
}

/**
 * LOCAL FIXTURE resolver for `file:<relative path>` references to a PEM public
 * key inside `baseDir`. The production guard rejects file references: the
 * production trust anchor must be a KMS asymmetric key.
 */
export class FileTrustedKeyResolver implements TrustedKeyResolver {
  readonly kind = "local_fixture" as const;
  constructor(private readonly baseDir: string) {}
  async resolve(ref: string): Promise<KeyObject | null> {
    if (!ref.startsWith("file:")) return null;
    const rel = ref.slice("file:".length);
    if (isAbsolute(rel) || rel.split("/").includes("..")) throw new ValidationError("APPROVAL_TRUST_KEY_REF_INVALID");
    const base = resolve(this.baseDir);
    const full = resolve(base, rel);
    if (!full.startsWith(base + "/")) throw new ValidationError("APPROVAL_TRUST_KEY_REF_INVALID");
    let pem: string;
    try {
      pem = readFileSync(full, "utf8");
    } catch {
      throw new ValidationError("APPROVAL_TRUST_KEY_UNREADABLE");
    }
    return parseTrustedPublicKey(pem);
  }
}

/** Minimal client surface of @aws-sdk/client-kms used here (injectable for offline tests). */
export interface KmsPublicKeyClient {
  send(command: unknown): Promise<{ PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string }>;
}

/**
 * Resolves `arn:aws:kms:...` references with the documented KMS GetPublicKey
 * API. Only SIGN_VERIFY keys with a supported key spec are accepted. Running it
 * requires AWS credentials and network access (BLOCKED offline; tests inject a
 * fixture client).
 */
export class KmsTrustedKeyResolver implements TrustedKeyResolver {
  readonly kind = "live" as const;
  constructor(
    private readonly client: KmsPublicKeyClient,
    private readonly makeCommand: (input: { KeyId: string }) => unknown,
  ) {}

  /** Builds a resolver using the real AWS SDK v3 KMS client. */
  static async create(region: string): Promise<KmsTrustedKeyResolver> {
    const kms = await import("@aws-sdk/client-kms");
    const client = new kms.KMSClient({ region });
    return new KmsTrustedKeyResolver(client as unknown as KmsPublicKeyClient, (input) => new kms.GetPublicKeyCommand(input));
  }

  async resolve(ref: string): Promise<KeyObject | null> {
    if (!/^arn:aws:kms:[a-z0-9-]{3,32}:\d{12}:key\/[A-Za-z0-9-]{1,128}$/.test(ref)) return null;
    let res: { PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
    try {
      res = await this.client.send(this.makeCommand({ KeyId: ref }));
    } catch {
      throw new ValidationError("APPROVAL_TRUST_KEY_UNAVAILABLE");
    }
    if (res.KeyUsage !== "SIGN_VERIFY" || !res.PublicKey) throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
    let key: KeyObject;
    try {
      key = createPublicKey({ key: Buffer.from(res.PublicKey), format: "der", type: "spki" });
    } catch {
      throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
    }
    if (algorithmForKey(key) === null) throw new ValidationError("APPROVAL_TRUST_KEY_INVALID");
    return key;
  }
}
