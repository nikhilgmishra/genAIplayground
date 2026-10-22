/**
 * UUID path segments and the egress URL scan (WP-08 decision on the wave B3 hand-off). Hosted IdPs such as Microsoft
 * Entra put the tenant id in the issuer path (`/<uuid>/v2.0`), which the URL scan refuses when the UUID happens to
 * hold a long decimal run (OIDC_EGRESS_REFUSED). A GENERIC "UUID-shaped segments are opaque" exemption was tried and
 * rejected: the RFC 9562 layout carries decimal data (a phone number, an SSN or a record number in its groups, plus a
 * few hex letters to look random). The exemption is instead a reviewed configuration constant: the destination lists
 * the exact UUIDs (`opaquePathIds`) that may appear as a whole path segment. A constant carries no request data.
 * All identifiers below are SYNTHETIC (random-looking hex written for this test, 555-01xx numbers).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { EgressGuard, urlCarriesSensitivePattern } from "./egress.js";
import type { EgressDestination, EgressPolicyConfig } from "./egress.js";

/** A tenant id whose node field is a 12-digit run: refused by the scan unless the destination lists it. */
const TENANT = "3f2b8c1e-5d4a-4e6f-9a7b-104857600123";
/** A second listed tenant id with no long decimal run: digits next to it are caught by the listed-constant rule alone. */
const HEX_TENANT = "a7c3e9f1-b2d4-4c6e-8f0a-bcdefabcdefa";
const IDP = "login.idp.example.test";
const OTHER_IDP = "other.idp.example.test";
const url = (host: string, pathAndQuery: string) => new URL(`https://${host}${pathAndQuery}`);

function idp(over: Partial<EgressDestination> = {}): EgressDestination {
  return {
    destinationId: "egr_tenant_idp",
    kind: "VERIFICATION_SERVICE",
    hosts: [IDP],
    allowedClasses: ["INTERNAL"],
    coverage: { baaRef: null, approvalId: null },
    environments: ["local", "ci", "sandbox"],
    adapterKind: "live",
    opaquePathIds: [TENANT, HEX_TENANT],
    ...over,
  };
}

const POLICY: EgressPolicyConfig = {
  policyVersion: "egress-uuid-test.2",
  destinations: [idp(), idp({ destinationId: "egr_other_idp", hosts: [OTHER_IDP], opaquePathIds: undefined })],
};

const guard = () => new EgressGuard(POLICY, { environment: "sandbox" });
const reason = (host: string, path: string) => guard().check(`https://${host}${path}`, "INTERNAL").reasonCode;

/** The s05 probe cases of the r2 security review: decimal identifiers in UUID groups, made "random-looking" with hex letters. */
const SMUGGLED = [
  "15550100-1234-4000-8000-000000000abc", // phone 1-555-0100-1234 in the first two groups
  "55501001-2345-4078-8051-120000000abc", // phone plus SSN-shaped digits
  "12345678-9012-4345-8678-901234abcdef", // account digits
  "55501000-0100-4000-8000-555010000123", // every digit decimal
  "3f6c2a1e-b7d4-4e8a-9c5f-005550100123", // random-looking prefix, zero-padded phone number as the node field
];

describe("UUID path segments: only reviewed constants are opaque [DATA-01][SPEC-6.no-phi-in-urls]", () => {
  it("[DATA-01] positive: the destination's listed tenant UUID is accepted in the issuer, discovery and JWKS paths (any case)", () => {
    expect(urlCarriesSensitivePattern(url(IDP, `/${TENANT}/v2.0`))).toBe(true); // the scan alone refuses it (12-digit run)
    for (const path of [`/${TENANT}/v2.0`, `/${TENANT}/v2.0/.well-known/openid-configuration`, `/${TENANT}/discovery/v2.0/keys`, `/${TENANT.toUpperCase()}/oauth2/v2.0/token`]) {
      expect(reason(IDP, path), path).toBe("EGRESS_ALLOWED");
    }
    expect(urlCarriesSensitivePattern(url(IDP, `/${TENANT}/v2.0`), { opaquePathIds: [TENANT] })).toBe(false);
  });

  it("[DATA-01] adversarial: the s05 smuggling cases (decimal data in UUID groups plus a few hex letters) are refused", () => {
    for (const uuid of SMUGGLED) {
      expect(urlCarriesSensitivePattern(url(IDP, `/tenants/${uuid}/v2.0`)), uuid).toBe(true);
      // Not listed: refused through the guard even at the destination that lists another UUID.
      expect(reason(IDP, `/tenants/${uuid}/v2.0`), uuid).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    }
  });

  it("[DATA-01] adversarial: the constant is exempt only at the destination that lists it, only as a whole path segment", () => {
    // Another destination (no list) and an unknown host: scanned, refused.
    expect(reason(OTHER_IDP, `/${TENANT}/v2.0`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(reason("unknown.idp.example.test", `/${TENANT}/v2.0`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    // Digits around the constant inside one segment: refused whatever their count.
    for (const segment of [`${TENANT}5550100123`, `5550100123${TENANT}`, `${TENANT}-555-0123`, `12-${TENANT}`, `${TENANT}_1990`]) {
      expect(reason(IDP, `/${segment}/v2.0`), segment).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    }
    // Short digit groups glued to a listed constant that has no long decimal run of its own: the general scan alone
    // would let a 2-4 digit fragment through, the listed-constant rule refuses any digit in the remainder.
    expect(reason(IDP, `/${HEX_TENANT}/v2.0`)).toBe("EGRESS_ALLOWED");
    for (const segment of [`${HEX_TENANT}1990`, `${HEX_TENANT}-0123`, `0101-${HEX_TENANT}`, `${HEX_TENANT}_12`, `${HEX_TENANT.toUpperCase()}7`]) {
      expect(urlCarriesSensitivePattern(url(OTHER_IDP, `/x/${segment}`)), `general scan alone: ${segment}`).toBe(false);
      expect(reason(IDP, `/${segment}/v2.0`), segment).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    }
    // An email around or after the constant: refused.
    expect(reason(IDP, `/${TENANT}@example.test/v2.0`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(reason(IDP, `/${TENANT}/avery%40example.test`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
  });

  it("[DATA-01] query and fragment values never use the exemption: the existing rules apply", () => {
    expect(reason(IDP, `/authorize?tenant=${TENANT}`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(reason(IDP, `/authorize#${TENANT}`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(reason(IDP, `/${TENANT}/v2.0?login_hint=555-010-0123`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    expect(reason(IDP, `/${TENANT}/v2.0?login_hint=avery%40example.test`)).toBe("EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    // Platform ids stay opaque anywhere, as before.
    expect(reason(IDP, `/${TENANT}/v2.0?state=st_synthState00000000000001`)).toBe("EGRESS_ALLOWED");
  });

  it("[DATA-01] unlisted random UUIDs keep the pre-existing whole-token scan (no new exemption, no new refusal)", () => {
    // Every unlisted UUID is scanned exactly as before: refused only when its digits form a sensitive span.
    let refused = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const u = randomUUID();
      const r = urlCarriesSensitivePattern(url(OTHER_IDP, `/${u}/v2.0`));
      // Equivalent to scanning the bare token text: the scan is unchanged for unlisted segments.
      expect(r).toBe(urlCarriesSensitivePattern(url(OTHER_IDP, `/x/${u}`)));
      if (r) refused += 1;
    }
    // About 6 % of random UUIDs hold a 9+ digit decimal run and fail closed; listing the constant is the fix.
    expect(refused).toBeLessThan(2_000 * 0.15);
    expect(urlCarriesSensitivePattern(url(OTHER_IDP, "/3f2b8c1e-5d4a-4e6f-9a7b-abcdefabcdef/v2.0"))).toBe(false);
  });

  it("[DATA-01] configuration: only lower-case canonical UUIDs may be listed (no free text, no arbitrary strings)", () => {
    for (const bad of ["5550100123", "3F2B8C1E-5D4A-4E6F-9A7B-104857600123", "tenant-a", "3f2b8c1e-5d4a-0e6f-9a7b-104857600123", ""]) {
      expect(() => new EgressGuard({ policyVersion: "bad.1", destinations: [idp({ opaquePathIds: [bad] })] }, { environment: "sandbox" }), bad).toThrow(ConfigurationRejectedError);
    }
    expect(() => new EgressGuard({ policyVersion: "bad.2", destinations: [idp({ opaquePathIds: [] })] }, { environment: "sandbox" })).toThrow(ConfigurationRejectedError);
  });

  it("[DATA-01] the existing path rules are unchanged for segments without a listed identifier", () => {
    expect(urlCarriesSensitivePattern(url(IDP, "/case/cas_synthCase0000000001"))).toBe(false);
    expect(urlCarriesSensitivePattern(url(IDP, "/case/5555550101"))).toBe(true);
    expect(urlCarriesSensitivePattern(url(IDP, "/person/1990-01-01"))).toBe(true);
    expect(urlCarriesSensitivePattern(url(IDP, "/realms/workforce"))).toBe(false);
  });
});
