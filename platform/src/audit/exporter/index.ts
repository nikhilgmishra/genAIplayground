/** Audit exporter (signed shipping) and the separate read-only verifier (WP-04). */
export { AuditExporter } from "./exporter.js";
export type { AuditExporterOptions } from "./exporter.js";
export { AuditExportVerifier, VERIFIER_DB_ROLE } from "./verifier.js";
export type { AuditExportVerifierOptions, AuditVerificationReport, ReconciliationSource, SignatureSummary, SourceReconciliation, VerifierIdentityCheck } from "./verifier.js";
export { KmsManifestSigner, LocalManifestSignerFixture, ManifestSignatureVerifier, MANIFEST_SIGNATURE_CONTEXT, manifestSigningInput } from "./signer.js";
export type { KmsSignSender, ManifestSignatureCheck, ManifestSigner } from "./signer.js";
// Scoped sink identities: the exporter writes, the verifier reads (STS session policies; WP-39 task roles in AWS).
export { assumeRoleWithSessionPolicy, sinkReaderPolicy, sinkWriterPolicy } from "./sts.js";
export type { AssumeRoleRequest, SessionCredentials, StaticCredentials, StsHttpPost } from "./sts.js";
