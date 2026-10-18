/**
 * Helpers for versioned resolution contracts (spec section 4).
 *
 * Every contract is validated against the strict protocol schema when the
 * module loads, so a malformed contract fails startup instead of silently
 * shaping caller-facing behaviour. All contracts are DRAFT: engineering
 * defaults pending business, clinical and privacy approval. The coding agent
 * cannot approve a contract (approvedBy is always null here).
 */
import { ResolutionContract } from "../../protocol/index.js";
import type { ResolutionContract as ResolutionContractT, Role } from "../../protocol/index.js";

export const ALL_AUDIENCES: readonly Role[] = [
  "client",
  "prospective_client",
  "provider",
  "practice_staff",
  "partner",
  "payer_representative",
  "personal_representative",
];

/** Note attached to every DRAFT contract in the generated document. */
export const DRAFT_NOTICE =
  "DRAFT - engineering default pending business, clinical and privacy approval. Not an approved procedure.";

export function defineContract(c: ResolutionContractT): ResolutionContractT {
  const parsed = ResolutionContract.parse(c);
  if (parsed.status === "APPROVED") throw new Error("CONTRACT_APPROVAL_NOT_ALLOWED_IN_CODE");
  if (parsed.approvedBy !== null) throw new Error("CONTRACT_APPROVER_NOT_ALLOWED_IN_CODE");
  return Object.freeze({ ...parsed });
}
