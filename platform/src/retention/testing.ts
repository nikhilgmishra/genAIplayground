/**
 * LOCAL TEST FIXTURES for retention tests (SYNTHETIC data only). Not imported
 * by production code.
 */
import type { DataClass } from "../protocol/index.js";
import type { RetentionApprovalVerifier } from "./ports.js";

/**
 * TEST-ONLY approval verifier: accepts the listed synthetic approval ids. It is
 * not an approval record and does not verify signatures; deployment binds the
 * config module's signed approval loader instead.
 */
export class TestOnlyRetentionApprovalVerifierFixture implements RetentionApprovalVerifier {
  readonly kind = "local_fixture" as const;
  constructor(private readonly validIds: ReadonlySet<string>) {}
  async verify(input: { approvalId: string; tenantId: string; dataClass: DataClass }): Promise<{ valid: boolean; approverRole: string | null; reasonCode: string }> {
    return this.validIds.has(input.approvalId)
      ? { valid: true, approverRole: "privacy_counsel", reasonCode: "APPROVAL_VALID" }
      : { valid: false, approverRole: null, reasonCode: "RETENTION_APPROVAL_INVALID" };
  }
}
