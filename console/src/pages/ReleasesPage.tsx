/**
 * Policy bundle and knowledge snapshot release review. A recorded review is an
 * opinion, NOT an approval record: releasing requires a signed approval record
 * (POLICY_RELEASE / KNOWLEDGE_RELEASE) from the accountable human approver,
 * which this console cannot create (spec sections 15 and 16; OPS-06).
 */
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { OPERATOR_REASON_CODES } from "../api/contract";
import type { ReleaseKind, ReleaseReviewDecision, ReleaseReviewItem } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS, canReviewRelease } from "../auth/roles";
import { useAnnouncer } from "../components/Announcer";
import { Dialog } from "../components/Dialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { QueryView } from "../components/QueryView";
import { EMPTY_REASON, ReasonFields, composeReason } from "../components/ReasonFields";
import type { ReasonValue } from "../components/ReasonFields";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { StatusText } from "../components/StatusText";
import type { Tone } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel } from "../lib/format";
import { newIdempotencyKey } from "../lib/random";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const KIND_LABEL: Readonly<Record<ReleaseKind, string>> = { POLICY_BUNDLE: "Policy bundle", KNOWLEDGE_SNAPSHOT: "Knowledge snapshot" };
const APPROVAL_TONE: Readonly<Record<ReleaseReviewItem["approvalStatus"], Tone>> = {
  MISSING: "bad",
  PRESENT: "ok",
  EXPIRED: "bad",
  SIGNATURE_INVALID: "bad",
};
const DECISION_LABEL: Readonly<Record<ReleaseReviewDecision, string>> = { NO_OBJECTION: "No objection", CHANGES_REQUESTED: "Changes requested" };

function ReviewDialog({ release, onClose, onDone }: { release: ReleaseReviewItem; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { announce } = useAnnouncer();
  const [decision, setDecision] = useState<ReleaseReviewDecision | "">("");
  const [reason, setReason] = useState<ReasonValue>(EMPTY_REASON);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());
  const codes = OPERATOR_REASON_CODES["releases.review"];
  const composed = composeReason(reason, codes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (decision === "" || !composed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.request("releases.review", {
        params: { releaseId: release.releaseId },
        body: { decision, reason: composed },
        idempotencyKey: keyRef.current,
      });
      announce(`Review ${res.reviewId} recorded for ${res.releaseId}. No approval record was created. Audit event ${res.auditEventId}.`);
      onDone();
    } catch (err) {
      setError(toConsoleApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Record review: ${KIND_LABEL[release.kind]} ${release.version}`}
      onClose={onClose}
      description={<p>This records your review only. It is not an approval and cannot release the {KIND_LABEL[release.kind].toLowerCase()}.</p>}
    >
      <form onSubmit={(e) => void submit(e)}>
        <fieldset className="fieldset">
          <legend>Review decision (required)</legend>
          {(["NO_OBJECTION", "CHANGES_REQUESTED"] as const).map((d) => (
            <div className="radio" key={d}>
              <input type="radio" id={`review-${d}`} name="review-decision" value={d} checked={decision === d} onChange={() => setDecision(d)} />
              <label htmlFor={`review-${d}`}>{DECISION_LABEL[d]}</label>
            </div>
          ))}
        </fieldset>
        <ReasonFields codes={codes} value={reason} onChange={setReason} />
        <ErrorNotice error={error} context="The review was not recorded." />
        <div className="dialog-actions">
          <button type="submit" disabled={decision === "" || !composed || busy}>
            Record review
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close without recording
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ReleaseCard({ release, onReview }: { release: ReleaseReviewItem; onReview: (r: ReleaseReviewItem) => void }) {
  const auth = useAuth();
  const headingId = `release-${release.releaseId}`;
  const ownSubmission = auth.me?.staff.staffId === release.submittedBy;
  const mayReview = canReviewRelease(release.kind, auth.roles);
  return (
    <article className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {KIND_LABEL[release.kind]} <code>{release.version}</code>
      </h2>
      <dl className="summary-grid">
        <div>
          <dt>Release item</dt>
          <dd>
            <code>{release.releaseId}</code>
          </dd>
        </div>
        <div>
          <dt>Previous version</dt>
          <dd>{release.previousVersion ? <code>{release.previousVersion}</code> : "None"}</dd>
        </div>
        <div>
          <dt>Digest (sha256)</dt>
          <dd>
            <code className="digest">{release.digest}</code>
          </dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>
            <Timestamp value={release.submittedAt} /> by <code>{release.submittedBy}</code>
          </dd>
        </div>
        <div>
          <dt>Approval record ({release.requiredApprovalScope})</dt>
          <dd>
            <StatusText tone={APPROVAL_TONE[release.approvalStatus]} label={enumLabel(release.approvalStatus)} />
            {release.approvalId ? (
              <>
                {" "}
                <code>{release.approvalId}</code>
              </>
            ) : null}
          </dd>
        </div>
      </dl>

      <table>
        <caption>
          Diff summary: {release.diffSummary.added} added, {release.diffSummary.removed} removed, {release.diffSummary.changed} changed
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Change</th>
            <th scope="col">Summary code</th>
          </tr>
        </thead>
        <tbody>
          {release.diffSummary.entries.map((e) => (
            <tr key={`${e.ref}-${e.change}`}>
              <th scope="row">
                <code>{e.ref}</code>
              </th>
              <td>{enumLabel(e.change)}</td>
              <td>
                <code>{e.summaryCode}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Recorded reviews</h3>
      {release.reviews.length === 0 ? (
        <p>No reviews recorded.</p>
      ) : (
        <ul className="plain-list">
          {release.reviews.map((r) => (
            <li key={r.reviewId}>
              {DECISION_LABEL[r.decision]} by <code>{r.reviewerStaffId}</code> ({ROLE_LABELS[r.reviewerRole]}), reason <code>{r.reason}</code>,{" "}
              <Timestamp value={r.at} />
            </li>
          ))}
        </ul>
      )}
      {mayReview && !ownSubmission ? (
        <button type="button" onClick={() => onReview(release)}>
          Record review
        </button>
      ) : (
        <p className="hint">
          {ownSubmission ? "You submitted this release, so you cannot review it." : "Reviewing this release kind is not permitted for your roles."}
        </p>
      )}
    </article>
  );
}

export function ReleasesPage() {
  useDocumentTitle("Releases review");
  const api = useApi();
  const query = useApiQuery(() => api.request("releases.list", {}), []);
  const [reviewing, setReviewing] = useState<ReleaseReviewItem | null>(null);
  return (
    <>
      <h1>Releases review</h1>
      <p className="notice notice-warn">
        Recording a review is not an approval. A policy bundle or knowledge snapshot is released only with a signed approval record
        (POLICY_RELEASE or KNOWLEDGE_RELEASE) from the accountable approver. This console cannot create approval records.
      </p>
      <ServerEnforcedNote />
      <QueryView query={query} label="releases">
        {(data) =>
          data.releases.length === 0 ? (
            <p>No releases pending review.</p>
          ) : (
            <>
              {data.releases.map((r) => (
                <ReleaseCard key={r.releaseId} release={r} onReview={setReviewing} />
              ))}
            </>
          )
        }
      </QueryView>
      {reviewing ? (
        <ReviewDialog
          release={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            query.reload();
          }}
        />
      ) : null}
    </>
  );
}
