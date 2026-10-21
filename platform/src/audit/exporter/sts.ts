/**
 * Scoped, short-lived sink credentials through the STS AssumeRole query API (follow-on FO-15-40, FO-15-42;
 * OPS-01). The audit exporter and the audit verifier must not share one sink identity: the exporter WRITES
 * (s3:PutObject, s3:PutObjectRetention) and cannot read evidence back; the verifier READS (s3:ListBucket,
 * s3:GetObject) and cannot write. In AWS each runs under its own task role (WP-39). Where only one
 * administrative identity exists — the local MinIO of the Layer-2 composition — this client derives a
 * temporary credential whose permissions are the intersection of the caller's and an inline SESSION
 * POLICY, which the S3 endpoint enforces (MinIO implements AssumeRole with session policies; AWS STS does
 * the same for a role ARN the caller may assume).
 *
 * The request is signed with AWS Signature Version 4 (service "sts") and sent through an INJECTED HTTP port
 * (`StsHttpPost`): this module opens no socket itself. The composition passes the egress-classified transport
 * (platform/src/connectors/http, an allowlisted destination; scripts/vsp/verify-audit.mts does so for the
 * local CLI). Errors are reason codes only; no credential value is ever logged or placed in an error.
 */
import { createHash, createHmac } from "node:crypto";
import { DependencyError, ValidationError } from "../../shared/errors.js";

export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface AssumeRoleRequest {
  /** STS endpoint, e.g. https://sts.us-east-1.amazonaws.com or the local MinIO URL. */
  endpoint: string;
  region: string;
  credentials: StaticCredentials;
  /** Role to assume (AWS); MinIO derives the session from the caller and ignores it. */
  roleArn: string;
  sessionName: string;
  /** Inline session policy (IAM JSON); the session can do only what both it and the caller allow. */
  policy: Record<string, unknown>;
  durationSeconds?: number;
}

/** The session policy of the sink WRITER: put objects with their retention, nothing else (no read back). */
export function sinkWriterPolicy(bucket: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:PutObject", "s3:PutObjectRetention"], Resource: [`arn:aws:s3:::${bucket}/*`] }],
  };
}

/** The session policy of the sink READER (the verifier): list and get, nothing else (no write). */
export function sinkReaderPolicy(bucket: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${bucket}`] },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectRetention"], Resource: [`arn:aws:s3:::${bucket}/*`] },
    ],
  };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([^<]{1,8192})</${name}>`).exec(xml);
  return m?.[1] ?? null;
};

/** One HTTPS POST of the STS query API (the egress-classified transport in production); `headers` include host. */
export interface StsHttpPost {
  post(url: URL, headers: Readonly<Record<string, string>>, body: string): Promise<{ status: number; body: string }>;
}

/** Calls STS AssumeRole (SigV4) through `http` and returns the temporary credentials. */
export async function assumeRoleWithSessionPolicy(req: AssumeRoleRequest, http: StsHttpPost, now: Date = new Date()): Promise<SessionCredentials> {
  let url: URL;
  try {
    url = new URL(req.endpoint);
  } catch {
    throw new ValidationError("AUDIT_STS_ENDPOINT_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new ValidationError("AUDIT_STS_ENDPOINT_INVALID");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(req.region)) throw new ValidationError("AUDIT_STS_REGION_INVALID");
  if (!/^[\w+=,.@-]{2,64}$/.test(req.sessionName)) throw new ValidationError("AUDIT_STS_SESSION_NAME_INVALID");
  const duration = req.durationSeconds ?? 900;
  if (!Number.isSafeInteger(duration) || duration < 900 || duration > 3600) throw new ValidationError("AUDIT_STS_DURATION_INVALID");
  const policy = JSON.stringify(req.policy);
  if (policy.length > 2048) throw new ValidationError("AUDIT_STS_POLICY_TOO_LARGE");

  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: req.roleArn,
    RoleSessionName: req.sessionName,
    DurationSeconds: String(duration),
    Policy: policy,
  }).toString();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const host = url.host;
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (req.credentials.sessionToken) headers["x-amz-security-token"] = req.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = `POST\n${url.pathname || "/"}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${req.region}/sts/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${req.credentials.secretAccessKey}`, day), req.region), "sts"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const sent: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };

  let status: number;
  let text: string;
  try {
    const res = await http.post(url, sent, body);
    status = res.status;
    text = res.body;
  } catch {
    throw new DependencyError("AUDIT_STS_UNAVAILABLE", "FAILED", true);
  }
  if (status !== 200) throw new DependencyError(status === 403 ? "AUDIT_STS_DENIED" : "AUDIT_STS_UNAVAILABLE", "FAILED", status >= 500);
  const accessKeyId = tag(text, "AccessKeyId");
  const secretAccessKey = tag(text, "SecretAccessKey");
  const sessionToken = tag(text, "SessionToken");
  const expiration = tag(text, "Expiration");
  const exp = expiration ? new Date(expiration) : null;
  if (!accessKeyId || !secretAccessKey || !sessionToken || !exp || Number.isNaN(exp.getTime())) throw new DependencyError("AUDIT_STS_RESPONSE_INVALID", "FAILED", false);
  if (accessKeyId === req.credentials.accessKeyId) throw new DependencyError("AUDIT_STS_RESPONSE_INVALID", "FAILED", false);
  return { accessKeyId, secretAccessKey, sessionToken, expiration: exp };
}
