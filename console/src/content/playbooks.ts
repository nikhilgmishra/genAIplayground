/**
 * Escalation roster and playbooks index (spec section 13), copied from
 * docs/RUNBOOKS/README.md. Every runbook is an undrilled draft; the named
 * roster is BLOCKED on PRQ-001 (named incident authority) and PRQ-011 (on-call
 * roster and paging). Keep in sync with the runbooks directory.
 */
export interface PlaybookEntry {
  id: string;
  title: string;
  severity: string;
  ownerRole: string;
  file: string;
}

export const PLAYBOOKS: readonly PlaybookEntry[] = [
  { id: "RB-PHI-EXPOSURE", title: "PHI exposure", severity: "SEV-1", ownerRole: "Security operations on-call", file: "phi-exposure.md" },
  { id: "RB-UNSAFE-OUTPUT", title: "Unsafe output", severity: "SEV-1", ownerRole: "Clinical safety lead", file: "unsafe-output.md" },
  { id: "RB-FAILED-SAFETY-TRANSFER", title: "Failed safety transfer", severity: "SEV-1", ownerRole: "Safety responder on-call", file: "failed-safety-transfer.md" },
  { id: "RB-AUTH-BYPASS", title: "Authentication bypass", severity: "SEV-1", ownerRole: "Security operations on-call", file: "authentication-bypass.md" },
  { id: "RB-DEPENDENCY-OUTAGE", title: "Dependency outage", severity: "SEV-2", ownerRole: "SRE on-call", file: "dependency-outage.md" },
  { id: "RB-UNEXPECTED-SPEND", title: "Unexpected spending", severity: "SEV-2", ownerRole: "Finance and platform owner", file: "unexpected-spending.md" },
  { id: "RB-DUPLICATE-COMMIT", title: "Duplicate commit", severity: "SEV-1", ownerRole: "SRE on-call", file: "duplicate-commit.md" },
  { id: "RB-VENDOR-CHANGE", title: "Vendor behaviour change", severity: "SEV-2", ownerRole: "Talkdesk administrator", file: "vendor-behavior-change.md" },
  { id: "RB-AI-OFF-ROUTE", title: "AI-off route and outage service mode", severity: "SEV-2", ownerRole: "Support operations lead", file: "ai-off-route.md" },
  { id: "RB-KILL-SWITCH", title: "Kill switch operations", severity: "Procedure", ownerRole: "Supervisor / security admin", file: "kill-switch-operations.md" },
  { id: "RB-UNKNOWN-COMMIT", title: "Reconciliation and DLQ repair", severity: "SEV-2 / SEV-3", ownerRole: "SRE on-call", file: "reconciliation-and-dlq-repair.md" },
  { id: "RB-AUDIT-OUTAGE", title: "Audit sink outage", severity: "SEV-1 / SEV-2", ownerRole: "Security operations on-call", file: "audit-sink-outage.md" },
  { id: "RB-RESTORE-DRILL", title: "Restore drill", severity: "Drill", ownerRole: "SRE lead", file: "restore-drill.md" },
  { id: "RB-REGIONAL-FAILOVER", title: "Regional failover", severity: "SEV-1", ownerRole: "Incident commander", file: "regional-failover.md" },
  { id: "RB-SECRET-ROTATION", title: "Secret rotation", severity: "Procedure / SEV-1 on compromise", ownerRole: "Security admin", file: "secret-rotation.md" },
  { id: "RB-ACCESS-REVIEW", title: "Access review", severity: "Procedure", ownerRole: "Security admin", file: "access-review.md" },
  { id: "RB-POLICY-RELEASE", title: "Policy release", severity: "Procedure", ownerRole: "Policy approver", file: "policy-release.md" },
  { id: "RB-KNOWLEDGE-RELEASE", title: "Knowledge release", severity: "Procedure", ownerRole: "Knowledge owner", file: "knowledge-release.md" },
];

export interface EscalationRole {
  role: string;
  responsibility: string;
}

export const ESCALATION_ROLES: readonly EscalationRole[] = [
  { role: "Incident commander", responsibility: "Named incident authority (PRQ-001); owns decisions, timeline and handoffs" },
  { role: "Safety responder on-call", responsibility: "Takes over affected callers; owns safety follow-up" },
  { role: "Clinical safety lead", responsibility: "Decides on clinical-boundary and safety script changes" },
  { role: "Privacy counsel", responsibility: "Determines reporting obligations and deadlines; approves external wording" },
  { role: "Security operations on-call", responsibility: "Containment, evidence preservation, forensic coordination" },
  { role: "SRE on-call", responsibility: "Platform actions, kill switches, recovery" },
  { role: "Support operations lead", responsibility: "Queue staffing, outage service mode, wait messages" },
  { role: "Talkdesk administrator / Salesforce administrator", responsibility: "Vendor configuration and vendor tickets" },
  { role: "Communications lead", responsibility: "Caller, partner and internal communications after privacy counsel approval" },
  { role: "Finance and platform owner", responsibility: "Spend decisions, vendor billing contacts" },
  { role: "Executive sponsor", responsibility: "Escalation and external commitments" },
];

/**
 * Operational dashboards (spec section 13): widget titles from
 * infra/terraform/modules/observability/main.tf. Plans only: never applied, and the
 * metrics export and paging are BLOCKED (PRQ-011, PRQ-047).
 */
export const DASHBOARDS: readonly { name: string; covers: string }[] = [
  { name: "call-flow", covers: "Call arrivals, live sessions, queue age p95, abandonment, human demand, transfers and disconnects, routing to a usable path, interaction outcomes" },
  { name: "identity", covers: "Verification attempts and failures, challenge abuse signals, denials" },
  { name: "tools-dependencies", covers: "Tool latency p50/p95/p99, tool calls, dependency errors, unknown commits, backlogs, duplicate effects" },
  { name: "safety", covers: "Safety signals, time to priority route, safety handoffs completed and failed, unsupported clinical requests, boundary violations" },
  { name: "crm-reconciliation", covers: "CRM reconciliation, CRM sync lag, queue oldest message age" },
  { name: "knowledge", covers: "Oldest approved item age, items needing review" },
  { name: "voice-experience", covers: "Turn latency, barge-in stop p95, interruptions" },
  { name: "cost-quotas", covers: "Spend, budget utilization, quota utilization, safety reserve overdraw (alert, never a cap)" },
  { name: "audit", covers: "Audit export completeness, audit backlog, ingestion gaps, protected actions without decision or audit" },
  { name: "admission-controls", covers: "Admission rejections, active AI sessions, kill switches engaged" },
  { name: "platform", covers: "Load balancer requests, 5xx and latency, healthy gateway targets, Aurora, session table throttles, ECS CPU and memory" },
];
