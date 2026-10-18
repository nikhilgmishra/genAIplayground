/** Public FAQ, login guidance and verification contracts (A0 work). DRAFT engineering defaults. */
import { ALL_AUDIENCES, defineContract } from "./define.js";

export const PUBLIC_FAQ = defineContract({
  contractId: "public_faq@1",
  intent: "public_faq",
  title: "Public FAQ from the reviewed public knowledge corpus",
  eligibleAudiences: [...ALL_AUDIENCES],
  requiredAssurance: "A0",
  permittedFields: ["articleId", "articleVersion", "body", "citationId", "title"],
  sourceSystem: "knowledge",
  allowedActions: ["public.read"],
  successEvidence: [
    "At least one approved PUBLIC knowledge item returned with its citation id and exact version (kb_<sourceId>@v<version>)",
    "The answer is grounded only in the returned article versions",
  ],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_support_general",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [
    "Any statement that is not grounded in a returned approved article version",
    "Account-specific facts or whether the caller has an account",
    "Clinical, diagnostic, therapeutic or medication guidance",
    "Phone numbers, dial instructions or links that are not in the approved article",
  ],
  humanBoundary: [
    "No approved public article matches the question",
    "Clinical or treatment questions go to the clinical boundary route",
  ],
  status: "DRAFT",
  approvedBy: null,
});

export const LOGIN_GUIDANCE = defineContract({
  contractId: "login_guidance@1",
  intent: "login_guidance",
  title: "Portal sign-in guidance without credential reset",
  eligibleAudiences: [...ALL_AUDIENCES],
  requiredAssurance: "A0",
  permittedFields: ["articleId", "articleVersion", "body", "citationId", "title"],
  sourceSystem: "knowledge",
  allowedActions: ["login_help.read"],
  successEvidence: [
    "Approved portal sign-in guidance article returned with its citation id and exact version",
    "Caller directed to the identity provider's own recovery process (no credential handled by the platform)",
  ],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_identity_recovery",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [
    "Asking for, accepting or repeating a password, passcode or one-time code",
    "Resetting credentials or bypassing the identity provider's recovery process",
    "Confirming or denying that an account exists for the caller",
  ],
  humanBoundary: [
    "Account locked, recovery already in progress or MFA device lost: trusted human recovery process",
    "Identity recovery is always the identity provider's process (identity:recover is a human boundary)",
  ],
  status: "DRAFT",
  approvedBy: null,
});

export const VERIFICATION = defineContract({
  contractId: "verification@1",
  intent: "verification",
  title: "Account verification through the restricted verification service",
  eligibleAudiences: [...ALL_AUDIENCES],
  requiredAssurance: "A0",
  permittedFields: ["nextStep", "status", "verificationId"],
  sourceSystem: "identity",
  allowedActions: ["verification.begin"],
  successEvidence: [
    "Session bound at A2 after the portal approval of the secure link (verification.bound) for this call and session generation",
    "Verification is a step toward another contract; it is never an issue resolution on its own",
  ],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_identity_recovery",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [
    "Disclosing whether zero, one or many accounts matched the locator",
    "Treating caller ID, date of birth, NPI or spoken claims as authentication",
    "Collecting a one-time code or password by voice",
    "Sending a challenge to a number or address supplied during the call",
    "Confirming that a person receives services before authorization",
  ],
  humanBoundary: [
    "Match ambiguity, failed verification or lockout: trusted human recovery process",
    "OTP fallback stays disabled until isolated DTMF capture (TB-03) is evidenced",
  ],
  status: "DRAFT",
  approvedBy: null,
});
