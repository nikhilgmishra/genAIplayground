/**
 * LIVE adapters for Talkdesk — BLOCKED.
 *
 * TalkdeskTelephonyLive (TelephonyControl) and TalkdeskExploreClient
 * (historical reports) are kind "live" but every method rejects with
 * BLOCKED_CAPABILITY_UNVERIFIED. No endpoint, path, payload, scope or event
 * name is implemented here because none has been documented for our plan:
 * public product documentation does not establish the tenant's APIs,
 * entitlements or behaviour (spec sections 1, 2 and 16). Inventing them would
 * simulate a capability as production success.
 *
 * What is publicly documented (source register) and why it is not enough:
 *  - [S3] AI Agent Platform MCP uses Streamable HTTP with bearer-token or OAuth2
 *    service authentication. That is the INBOUND tool transport into the
 *    gateway, not a telephony-control API, and service authentication does not
 *    authenticate the caller.
 *  - [S24] Talkdesk Explore API generates historical reports. Which reports
 *    exist for our plan, their fields, pagination, retry behaviour, report
 *    limits and transcript / raw-audio availability must be verified report by
 *    report (spec section 15, VQ-TD-36).
 *
 * Until the evidence below exists, the platform's transfer coordinator runs
 * against the LOCAL TelephonyFixture only, and live transfers remain with the
 * independent Talkdesk Studio human route (spec section 3).
 */
import type { DestinationId } from "../../protocol/index.js";
import type { Adapter, TelephonyControl } from "../ports.js";
import { BlockedLiveAdapter, type RequiredEvidence } from "./blocked-base.js";

export const TALKDESK_TELEPHONY_PREREQUISITES = ["PRQ-004", "PRQ-034", "PRQ-014", "PRQ-019", "PRQ-021", "PRQ-022", "PRQ-024"] as const;

export const TALKDESK_TELEPHONY_REQUIRED_EVIDENCE: readonly RequiredEvidence[] = [
  {
    capability: "Transfer an in-progress call to a configured queue or destination by identifier",
    evidence:
      "Documented API or deterministic Studio step for our plan: method, path, API version, auth mechanism (OAuth2 client credentials for the telephony_control identity), request/response schema, error codes, idempotency behaviour, rate limits; it must accept only configured queue/destination identifiers, never a dial string",
    prerequisites: ["PRQ-004", "PRQ-034"],
    vendorQuestions: ["VQ-TD-22", "VQ-TD-27", "VQ-TD-28", "VQ-TD-39"],
    trustBoundary: "TB-02",
  },
  {
    capability: "Transfer lifecycle events (queued, receiver accepted, bridged, caller confirmed connected, timeout, failure, disconnect)",
    evidence: "Documented event/webhook/API export with timestamps and interaction ids, delivery semantics (ordering, duplicates, redelivery) and retention",
    prerequisites: ["PRQ-019"],
    vendorQuestions: ["VQ-TD-33", "VQ-TD-41"],
    trustBoundary: "TB-07",
  },
  {
    capability: "Authenticated event / webhook delivery",
    evidence: "Vendor-documented webhook authentication (signature scheme, timestamp or nonce, replay protection) for our plan; no signature protocol is invented here",
    prerequisites: ["PRQ-021"],
    vendorQuestions: ["VQ-TD-34"],
    trustBoundary: "TB-09",
  },
  {
    capability: "Play an approved update to a held caller by template / prompt identifier",
    evidence: "Documented mechanism to play a pre-approved Studio prompt or audio asset by identifier (no free text) while the caller stays connected",
    prerequisites: ["PRQ-004", "PRQ-014"],
    vendorQuestions: ["VQ-TD-27", "VQ-TD-28"],
    trustBoundary: "TB-02",
  },
  {
    capability: "Contracted capacity for transfer legs and control API calls",
    evidence: "Written per-tenant quotas and throttling behaviour",
    prerequisites: ["PRQ-022"],
    vendorQuestions: ["VQ-TD-10", "VQ-TD-11", "VQ-TD-43"],
    trustBoundary: "TB-10",
  },
];

export class TalkdeskTelephonyLive extends BlockedLiveAdapter implements TelephonyControl {
  readonly integrationId = "talkdesk-telephony";
  readonly prerequisites: readonly string[] = TALKDESK_TELEPHONY_PREREQUISITES;
  readonly requiredEvidence = TALKDESK_TELEPHONY_REQUIRED_EVIDENCE;

  async requestTransfer(_input: { callId: string; destinationId: DestinationId; handoffId: string; priority: "SAFETY" | "STANDARD" }): Promise<{ transferRef: string }> {
    return this.blocked("requestTransfer");
  }

  async playApprovedUpdate(_input: { callId: string; templateId: string }): Promise<void> {
    return this.blocked("playApprovedUpdate");
  }

  /** Transfer lifecycle event ingestion (TB-07 / TB-09). */
  async subscribeTransferEvents(_callback: (event: unknown) => void): Promise<() => void> {
    return this.blocked("subscribeTransferEvents");
  }
}

// ---------------------------------------------------------------------------
// Talkdesk Explore (historical reports) [S24]
// ---------------------------------------------------------------------------

/** Port for approved, rate-limited historical report exports (spec section 15, Phase 0). */
export interface HistoricalReportSource extends Adapter {
  /** `reportType` is an opaque configured identifier; report names for our plan are UNKNOWN. */
  requestReport(input: { reportType: string; fromDate: string; toDate: string }): Promise<{ jobRef: string }>;
  reportStatus(jobRef: string): Promise<{ state: "PENDING" | "READY" | "FAILED" }>;
  readReportPage(jobRef: string, cursor: string | null): Promise<{ rows: Record<string, string | number | null>[]; nextCursor: string | null }>;
}

export const TALKDESK_EXPLORE_PREREQUISITES = ["PRQ-046", "PRQ-004", "PRQ-034", "PRQ-002", "PRQ-024"] as const;

export const TALKDESK_EXPLORE_REQUIRED_EVIDENCE: readonly RequiredEvidence[] = [
  {
    capability: "Historical report generation and download for our plan",
    evidence:
      "Documented Explore API facts for our plan: available report types, their fields and restrictions, request/poll/download endpoints and versions, pagination, retry behaviour, report and rate limits, OAuth2 scopes",
    prerequisites: ["PRQ-004", "PRQ-034"],
    vendorQuestions: ["VQ-TD-36", "VQ-TD-09", "VQ-TD-24"],
    trustBoundary: null,
  },
  {
    capability: "De-identified traffic statistics export scope",
    evidence: "Privacy counsel approval of a minimized export (half-hour arrivals, handle times, language/queue mix, transfers, abandonment) without raw audio or transcripts; per-report transcript/raw-audio availability confirmed",
    prerequisites: ["PRQ-046", "PRQ-002"],
    vendorQuestions: ["VQ-TD-36", "VQ-TD-05"],
    trustBoundary: null,
  },
];

export class TalkdeskExploreClient extends BlockedLiveAdapter implements HistoricalReportSource {
  readonly integrationId = "talkdesk-explore";
  readonly prerequisites: readonly string[] = TALKDESK_EXPLORE_PREREQUISITES;
  readonly requiredEvidence = TALKDESK_EXPLORE_REQUIRED_EVIDENCE;

  async requestReport(_input: { reportType: string; fromDate: string; toDate: string }): Promise<{ jobRef: string }> {
    return this.blocked("requestReport");
  }

  async reportStatus(_jobRef: string): Promise<{ state: "PENDING" | "READY" | "FAILED" }> {
    return this.blocked("reportStatus");
  }

  async readReportPage(_jobRef: string, _cursor: string | null): Promise<{ rows: Record<string, string | number | null>[]; nextCursor: string | null }> {
    return this.blocked("readReportPage");
  }
}
