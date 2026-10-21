/**
 * Path construction for console API calls and console routes.
 *
 * Only opaque identifiers may appear in a URL (spec section 6). Every path
 * parameter is validated against the contract's pattern before a request is
 * built, and invalid values are rejected WITHOUT echoing them anywhere (an
 * invalid value could be a phone number or a name typed into the address bar).
 */
import {
  CONSOLE_ENDPOINTS,
  DESTINATION_ID_PATTERN,
  OPAQUE_ID_PATTERN,
  OPERATOR_REASON_PATTERN,
  PATH_PARAM_PATTERNS,
  SUPPORT_REFERENCE_PATTERN,
} from "./contract";
import type { EndpointKey, PathParamName, PathParams } from "./contract";

const OPAQUE_RE = new RegExp(OPAQUE_ID_PATTERN);
const SUPPORT_REF_RE = new RegExp(SUPPORT_REFERENCE_PATTERN);
const DESTINATION_RE = new RegExp(DESTINATION_ID_PATTERN);
const OPERATOR_REASON_RE = new RegExp(OPERATOR_REASON_PATTERN);
const FOUR_DIGIT_RUN = /\d{4,}/;

const PARAM_RE: Readonly<Record<PathParamName, RegExp>> = {
  callId: new RegExp(PATH_PARAM_PATTERNS.callId),
  ref: new RegExp(PATH_PARAM_PATTERNS.ref),
  actionId: new RegExp(PATH_PARAM_PATTERNS.actionId),
  messageId: new RegExp(PATH_PARAM_PATTERNS.messageId),
  taskId: new RegExp(PATH_PARAM_PATTERNS.taskId),
  releaseId: new RegExp(PATH_PARAM_PATTERNS.releaseId),
  requestId: new RegExp(PATH_PARAM_PATTERNS.requestId),
  reviewId: new RegExp(PATH_PARAM_PATTERNS.reviewId),
  identityId: new RegExp(PATH_PARAM_PATTERNS.identityId),
};

export const isOpaqueId = (value: string): boolean => OPAQUE_RE.test(value);
export const isSupportReference = (value: string): boolean => SUPPORT_REF_RE.test(value);
export const isDestinationId = (value: string): boolean => DESTINATION_RE.test(value);
export const isOperatorReason = (value: string): boolean =>
  OPERATOR_REASON_RE.test(value) && !FOUR_DIGIT_RUN.test(value.split(":")[0] ?? "");

/** Thrown when a path parameter is not an opaque reference. Carries the parameter NAME only. */
export class InvalidReferenceError extends Error {
  readonly reasonCode = "INVALID_REFERENCE";
  constructor(readonly paramName: string) {
    super(`INVALID_REFERENCE:${paramName}`);
    this.name = "InvalidReferenceError";
  }
}

function isParamName(name: string): name is PathParamName {
  return Object.prototype.hasOwnProperty.call(PARAM_RE, name);
}

/** Builds an API path from the contract template, validating and encoding every parameter. */
export function buildApiPath<K extends EndpointKey>(key: K, params: PathParams<K>): string {
  const values = params as Record<string, string | undefined>;
  return CONSOLE_ENDPOINTS[key].path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name];
    if (!isParamName(name) || value === undefined || !PARAM_RE[name].test(value)) throw new InvalidReferenceError(name);
    return encodeURIComponent(value);
  });
}

/** Serializes defined query values. Only metadata filters and opaque ids are ever passed. */
export function buildQueryString(query: object | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/** Console route builders (browser URLs). Same opaque-only rule. */
export const consoleRoutes = {
  call: (callId: string): string => {
    if (!isOpaqueId(callId)) throw new InvalidReferenceError("callId");
    return `/calls/${encodeURIComponent(callId)}`;
  },
  supportRequest: (ref: string): string => {
    if (!isSupportReference(ref)) throw new InvalidReferenceError("ref");
    return `/support-requests/${encodeURIComponent(ref)}`;
  },
};
