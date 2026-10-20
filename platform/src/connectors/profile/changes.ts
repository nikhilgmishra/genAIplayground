/**
 * Pinned, reviewed and audited profile changes (WP-06; FO-06-18; OPS-01, OPS-06).
 *
 * A connector runs on exactly one admitted profile version per (tenant, profile id). A change:
 *   - is a NEW profileVersion (monotonic) whose configDigest differs;
 *   - carries a review bound to that exact digest by a reviewer who is not the author (two-person rule),
 *     with an approval id;
 *   - is recorded as a content-free audit event BEFORE it takes effect; when the audit port cannot record
 *     it, the change is refused and the old version stays active (fail closed).
 * The durable configuration store and the operator studio are WP-31 / WP-33; this registry is the
 * process-local gate they publish through.
 */
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, PlatformError, ValidationError } from "../../shared/errors.js";
import type { AdmittedProfile } from "./validate.js";

export interface ProfileChangeReview {
  /** Approval record id (apr_...). */
  approvalId: string;
  /** Workforce ids (stf_...) of the author and the reviewer; they must differ. */
  authorRef: string;
  reviewerRef: string;
  /** The digest the reviewer approved; must equal the new profile's configDigest. */
  reviewedDigest: string;
}

export interface ConnectorProfileAuditEvent {
  action: "connector.profile.activated" | "connector.profile.change_refused";
  tenantId: string;
  profileId: string;
  fromVersion: number | null;
  toVersion: number;
  fromDigest: string | null;
  toDigest: string;
  approvalId: string | null;
  reviewerRef: string | null;
  reasonCode: string;
  occurredAt: string;
}

/** Durable audit port (the composition binds it to the audit writer, platform/src/audit). */
export interface ConnectorAuditPort {
  record(event: ConnectorProfileAuditEvent): Promise<void>;
}

export class ConnectorProfileRegistry {
  private readonly active = new Map<string, AdmittedProfile>();

  constructor(
    private readonly audit: ConnectorAuditPort,
    private readonly clock: Clock,
  ) {}

  get(tenantId: string, profileId: string): AdmittedProfile | null {
    return this.active.get(`${tenantId}|${profileId}`) ?? null;
  }

  list(): AdmittedProfile[] {
    return [...this.active.values()].sort((a, b) => a.profile.profileId.localeCompare(b.profile.profileId));
  }

  /** Activates `next` after review and audit; returns false when it is already the active version. */
  async activate(next: AdmittedProfile, review: ProfileChangeReview | null): Promise<boolean> {
    const key = `${next.profile.tenantId}|${next.profile.profileId}`;
    const current = this.active.get(key) ?? null;
    if (current && current.digest === next.digest) return false;
    const refuse = async (reasonCode: string): Promise<never> => {
      await this.audit
        .record(this.event("connector.profile.change_refused", current, next, review, reasonCode))
        .catch(() => undefined);
      throw new AccessDeniedError(reasonCode);
    };
    if (review === null) return refuse("CONNECTOR_PROFILE_REVIEW_REQUIRED");
    if (!/^apr_[A-Za-z0-9_-]{8,64}$/.test(review.approvalId)) return refuse("CONNECTOR_PROFILE_APPROVAL_INVALID");
    if (!/^stf_[A-Za-z0-9_-]{8,64}$/.test(review.authorRef) || !/^stf_[A-Za-z0-9_-]{8,64}$/.test(review.reviewerRef)) return refuse("CONNECTOR_PROFILE_REVIEWER_INVALID");
    if (review.authorRef === review.reviewerRef) return refuse("CONNECTOR_PROFILE_SELF_REVIEW");
    if (review.reviewedDigest !== next.digest) return refuse("CONNECTOR_PROFILE_REVIEW_DIGEST_MISMATCH");
    if (current && next.profile.profileVersion <= current.profile.profileVersion) return refuse("CONNECTOR_PROFILE_VERSION_NOT_INCREASED");
    try {
      await this.audit.record(this.event("connector.profile.activated", current, next, review, "CONNECTOR_PROFILE_ACTIVATED"));
    } catch {
      // No durable evidence, no change (OPS-01).
      throw new PlatformError("CONNECTOR_PROFILE_AUDIT_UNAVAILABLE", "CONNECTOR_PROFILE_AUDIT_UNAVAILABLE", true);
    }
    this.active.set(key, next);
    return true;
  }

  private event(action: ConnectorProfileAuditEvent["action"], current: AdmittedProfile | null, next: AdmittedProfile, review: ProfileChangeReview | null, reasonCode: string): ConnectorProfileAuditEvent {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reasonCode)) throw new ValidationError("REASON_CODE_INVALID");
    return {
      action,
      tenantId: next.profile.tenantId,
      profileId: next.profile.profileId,
      fromVersion: current?.profile.profileVersion ?? null,
      toVersion: next.profile.profileVersion,
      fromDigest: current?.digest ?? null,
      toDigest: next.digest,
      approvalId: review && /^apr_[A-Za-z0-9_-]{8,64}$/.test(review.approvalId) ? review.approvalId : null,
      reviewerRef: review && /^stf_[A-Za-z0-9_-]{8,64}$/.test(review.reviewerRef) ? review.reviewerRef : null,
      reasonCode,
      occurredAt: this.clock.now().toISOString(),
    };
  }
}
