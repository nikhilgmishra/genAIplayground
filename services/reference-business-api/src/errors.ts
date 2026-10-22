/**
 * API errors: an HTTP status and a stable reason code. Bodies carry the code only (never record values), so a
 * client can classify without reading free text. Status mapping (documented in the OpenAPI file):
 *   400 REQUEST_INVALID           malformed input
 *   401 UNAUTHENTICATED           missing or invalid bearer token
 *   403 SCOPE_MISSING / AUTHORITY_REFUSED / ACCOUNT_MISMATCH
 *   404 NOT_FOUND                 absent, or not visible to this account (never distinguished)
 *   409 VERSION_CONFLICT / SLOT_UNAVAILABLE / STATE_CONFLICT   the record changed since it was read
 *   422 REQUEST_ID_REUSED         a request id replayed with a different request
 *   500 PARTIAL_WRITE             a multi-step write applied its first step only (complete it by request id)
 *   503 UNAVAILABLE / REQUEST_IN_PROGRESS (Retry-After)
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export const notFound = (): ApiError => new ApiError(404, "NOT_FOUND");
export const invalid = (): ApiError => new ApiError(400, "REQUEST_INVALID");
