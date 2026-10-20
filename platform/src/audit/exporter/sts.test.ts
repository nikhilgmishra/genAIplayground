/**
 * STS AssumeRole client (sts.ts): request shape, SigV4 header layout, input bounds and reason-coded failures.
 * The HTTP port is a UNIT FAKE (a recorder); the signature itself is verified by a real STS endpoint in Layer 2
 * (MinIO through the egress-classified transport, test/integration/substrate/audit-export.test.ts, which also
 * refuses a wrong secret).
 */
import { describe, expect, it } from "vitest";
import { assumeRoleWithSessionPolicy, sinkReaderPolicy, sinkWriterPolicy } from "./sts.js";
import type { AssumeRoleRequest, StsHttpPost } from "./sts.js";

const SECRET = "sts_synthSecretKeyNotReal000000000000000";
const base = (over: Partial<AssumeRoleRequest> = {}): AssumeRoleRequest => ({
  endpoint: "https://sts.minio.vsp.local/",
  region: "us-east-1",
  credentials: { accessKeyId: "SYNTHETICADMIN0001", secretAccessKey: SECRET },
  roleArn: "arn:aws:iam::123456789012:role/vsp-audit-verifier-local",
  sessionName: "vsp-verify-audit",
  policy: sinkReaderPolicy("vsp-audit-synthetic"),
  ...over,
});

const OK_XML = `<?xml version="1.0"?><AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>SYNTHETICSESSION01</AccessKeyId><SecretAccessKey>sts_synthSessionSecret0001</SecretAccessKey><SessionToken>sts_synthSessionToken0001</SessionToken><Expiration>2026-10-19T12:15:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`;

/** UNIT FAKE of the HTTP port: records the request and answers with a fixed status and body. */
function recorder(status: number, body: string) {
  const calls: { url: string; init: { method: string; headers: Readonly<Record<string, string>>; body: string } }[] = [];
  const fetchImpl: StsHttpPost = {
    async post(url, headers, sent) {
      calls.push({ url: url.toString(), init: { method: "POST", headers, body: sent } });
      return { status, body };
    },
  };
  return { calls, fetchImpl };
}

describe("assumeRoleWithSessionPolicy", () => {
  it("[FO-15-40][FO-15-42] signs a form POST (SigV4, service sts) carrying the inline session policy and returns the temporary credentials", async () => {
    const { calls, fetchImpl } = recorder(200, OK_XML);
    const creds = await assumeRoleWithSessionPolicy(base(), fetchImpl, new Date("2026-10-19T12:00:00.000Z"));
    expect(creds).toEqual({ accessKeyId: "SYNTHETICSESSION01", secretAccessKey: "sts_synthSessionSecret0001", sessionToken: "sts_synthSessionToken0001", expiration: new Date("2026-10-19T12:15:00Z") });
    const call = calls[0];
    expect(call?.url).toBe("https://sts.minio.vsp.local/");
    expect(call?.init.headers.host).toBe("sts.minio.vsp.local");
    expect(call?.init.method).toBe("POST");
    const form = new URLSearchParams(call?.init.body ?? "");
    expect(form.get("Action")).toBe("AssumeRole");
    expect(form.get("Version")).toBe("2011-06-15");
    expect(form.get("DurationSeconds")).toBe("900");
    expect(JSON.parse(form.get("Policy") ?? "{}")).toEqual(sinkReaderPolicy("vsp-audit-synthetic"));
    const auth = call?.init.headers.authorization ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=SYNTHETICADMIN0001\/20261019\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    expect(call?.init.headers["x-amz-date"]).toBe("20261019T120000Z");
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("[FO-15-42] the writer policy only puts objects and their retention; the reader policy only lists and gets", () => {
    const w = JSON.stringify(sinkWriterPolicy("b-1"));
    expect(w).toContain("s3:PutObject");
    expect(w).not.toMatch(/GetObject|ListBucket/);
    const r = JSON.stringify(sinkReaderPolicy("b-1"));
    expect(r).toMatch(/s3:GetObject/);
    expect(r).toMatch(/s3:ListBucket/);
    expect(r).not.toMatch(/Put|Delete/);
  });

  it("[OPS-03] bounds: https only (the transport may route it to a loopback emulator), duration 900..3600 s, a bounded policy and session name", async () => {
    const { fetchImpl, calls } = recorder(200, OK_XML);
    await expect(assumeRoleWithSessionPolicy(base({ endpoint: "http://sts.example.invalid" }), fetchImpl)).rejects.toThrow("AUDIT_STS_ENDPOINT_INVALID");
    await expect(assumeRoleWithSessionPolicy(base({ endpoint: "https://user:pw@sts.example.invalid/" }), fetchImpl)).rejects.toThrow("AUDIT_STS_ENDPOINT_INVALID");
    await expect(assumeRoleWithSessionPolicy(base({ durationSeconds: 60 }), fetchImpl)).rejects.toThrow("AUDIT_STS_DURATION_INVALID");
    await expect(assumeRoleWithSessionPolicy(base({ sessionName: "bad name!" }), fetchImpl)).rejects.toThrow("AUDIT_STS_SESSION_NAME_INVALID");
    await expect(assumeRoleWithSessionPolicy(base({ policy: { big: "x".repeat(3000) } }), fetchImpl)).rejects.toThrow("AUDIT_STS_POLICY_TOO_LARGE");
    expect(calls).toHaveLength(0);
  });

  it("[OPS-03] failures are reason codes without credential material: denied, unavailable, malformed, and a session that would be the caller's own key", async () => {
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string; message?: string }) => `${e.reasonCode}|${e.message}`);
    expect(await reason(assumeRoleWithSessionPolicy(base(), recorder(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>").fetchImpl))).toMatch(/^AUDIT_STS_DENIED/);
    expect(await reason(assumeRoleWithSessionPolicy(base(), recorder(503, "busy").fetchImpl))).toMatch(/^AUDIT_STS_UNAVAILABLE/);
    expect(await reason(assumeRoleWithSessionPolicy(base(), recorder(200, "<x/>").fetchImpl))).toMatch(/^AUDIT_STS_RESPONSE_INVALID/);
    expect(await reason(assumeRoleWithSessionPolicy(base(), recorder(200, OK_XML.replace("SYNTHETICSESSION01", "SYNTHETICADMIN0001")).fetchImpl))).toMatch(/^AUDIT_STS_RESPONSE_INVALID/);
    const failing: StsHttpPost = {
      post: async () => {
        throw new Error(`connect refused ${SECRET}`);
      },
    };
    const r = await reason(assumeRoleWithSessionPolicy(base(), failing));
    expect(r).toMatch(/^AUDIT_STS_UNAVAILABLE/);
    expect(r).not.toContain(SECRET);
  });
});
