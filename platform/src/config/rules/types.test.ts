/**
 * Reference identity of the key and secret separation rule (rules/types.ts sameKeyOrSecret; WP-07, AUTH-02,
 * FO-14-56). The helper decides whether two configuration references name the same KMS key or the same secret, so
 * one key or secret cannot pass for two by spelling. Hypothetical references only (AWS documentation account ids).
 */
import { describe, expect, it } from "vitest";
import { canonicalReferences, isKmsAliasRef, sameKeyOrSecret } from "./types.js";

const ACCOUNT = "111122223333";
const UUID = "abcdef01-2345-6789-abcd-ef0123456789";
const MRK = "mrk-0123456789abcdef0123456789abcdef";

describe("sameKeyOrSecret [AUTH-02][FO-14-56]", () => {
  it("[AUTH-02] a KMS key ARN matches its bare key id in any region or account and in any letter case", () => {
    expect(sameKeyOrSecret(`arn:aws:kms:us-east-1:${ACCOUNT}:key/${UUID}`, UUID)).toBe(true);
    expect(sameKeyOrSecret(UUID, `arn:aws:kms:eu-west-1:${ACCOUNT}:key/${UUID.toUpperCase()}`)).toBe(true);
    // Bare key ids compared without regard to case (both sides bare).
    expect(sameKeyOrSecret(UUID.toUpperCase(), UUID)).toBe(true);
    expect(sameKeyOrSecret(UUID, "abcdef01-2345-6789-abcd-ef0123456780")).toBe(false);
  });

  it("[AUTH-02] a multi-region key id (mrk-) matches its replicas' ARNs and its bare id in any case", () => {
    expect(sameKeyOrSecret(MRK, `arn:aws:kms:us-west-2:${ACCOUNT}:key/${MRK}`)).toBe(true);
    expect(sameKeyOrSecret(MRK.toUpperCase().replace("MRK-", "mrk-"), `arn:aws:kms:us-east-1:${ACCOUNT}:key/${MRK}`)).toBe(true);
    expect(sameKeyOrSecret(MRK, `arn:aws:kms:us-east-1:${ACCOUNT}:key/mrk-0123456789abcdef0123456789abcdee`)).toBe(false);
  });

  it("[AUTH-02] aliases match by name only; an alias never matches a key id (which key it names is not visible)", () => {
    expect(sameKeyOrSecret("alias/vsp-assertions", `arn:aws:kms:us-east-1:${ACCOUNT}:alias/VSP-Assertions`)).toBe(true);
    expect(sameKeyOrSecret("alias/vsp-assertions", UUID)).toBe(false);
    expect(isKmsAliasRef("alias/vsp-assertions")).toBe(true);
    expect(isKmsAliasRef(`arn:aws:kms:us-east-1:${ACCOUNT}:key/${UUID}`)).toBe(false);
  });

  it("[AUTH-02][DATA-01] a full Secrets Manager ARN matches the partial ARN of the same secret in the same region and account only", () => {
    const partial = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:vsp-prod-pepper`;
    expect(sameKeyOrSecret(partial, `${partial}-Ab12Cd`)).toBe(true);
    expect(sameKeyOrSecret(`${partial}-Ab12Cd`, partial)).toBe(true);
    expect(sameKeyOrSecret(partial, partial.replace("us-east-1", "us-west-2"))).toBe(false);
    expect(sameKeyOrSecret(partial, partial.replace(ACCOUNT, "444455556666"))).toBe(false);
    // The suffix is ignored on one side only: two different full ARNs with a common prefix stay different.
    expect(sameKeyOrSecret(`${partial}-Ab12Cd`, `${partial}-Zz98Yx`)).toBe(false);
  });

  it("[AUTH-02] SSM parameters match by name within one region and account; null or empty references never match", () => {
    const p = `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/vsp/prod/pepper`;
    expect(sameKeyOrSecret(p, p)).toBe(true);
    expect(sameKeyOrSecret(p, p.replace("us-east-1", "eu-west-1"))).toBe(false);
    expect(sameKeyOrSecret(null, null)).toBe(false);
    expect(sameKeyOrSecret("", "")).toBe(false);
    expect(sameKeyOrSecret(undefined, p)).toBe(false);
  });
});

describe("canonicalReferences [AUTH-02][FT-91]", () => {
  const partial = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:vsp-prod-billing`;
  it("[AUTH-02] every spelling of one identity maps to one reference (the first seen): a full and a partial Secrets Manager ARN, a key ARN and its bare id", () => {
    const keyArn = `arn:aws:kms:us-east-1:${ACCOUNT}:key/${UUID}`;
    const m = canonicalReferences([`${partial}-Ab12Cd`, keyArn, partial, UUID.toUpperCase()]);
    expect(m.get(partial)).toBe(`${partial}-Ab12Cd`);
    expect(m.get(`${partial}-Ab12Cd`)).toBe(`${partial}-Ab12Cd`);
    expect(m.get(UUID.toUpperCase())).toBe(keyArn);
    // Transitive: two full ARNs that each match the same partial ARN join it (fail closed).
    const t = canonicalReferences([`${partial}-Ab12Cd`, `${partial}-Zz98Yx`, partial]);
    expect(new Set(t.values())).toEqual(new Set([`${partial}-Ab12Cd`]));
  });
  it("[AUTH-02] different secrets stay different: a common prefix, another region or account, an empty reference", () => {
    const a = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:vsp-pepper-prod01`;
    const b = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:vsp-pepper-test01`;
    const m = canonicalReferences([a, b, partial, partial.replace("us-east-1", "us-west-2"), partial.replace(ACCOUNT, "444455556666"), ""]);
    expect(m.get(b)).toBe(b);
    expect(m.get(partial.replace("us-east-1", "us-west-2"))).toBe(partial.replace("us-east-1", "us-west-2"));
    expect(m.get(partial.replace(ACCOUNT, "444455556666"))).toBe(partial.replace(ACCOUNT, "444455556666"));
    expect(m.has("")).toBe(false);
    expect(new Set(m.values()).size).toBe(5);
  });
});
