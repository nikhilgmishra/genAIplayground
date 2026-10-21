/**
 * Alarm rules of the live composition, as code (WP-07; FO-03-30, FO-17-24.DLQ_FULL, OPS-01, DATA-01).
 *
 * Each rule names a catalogue metric (content-free: closed label enums), a statistic over a period, a
 * threshold and a missing-data treatment, exactly the fields a CloudWatch alarm takes. The Terraform alarms of
 * infra/terraform/modules/observability are owned by WP-39 in phase G; until it renders these rules there, the
 * same definitions are evaluated in process (`evaluateAlarm`) by the composition tests and by the Layer-2 fault
 * runs, so "the alarm rule fires" is a statement about this rule, not about a test-local threshold.
 *
 * Log-event alarms (error-level events that page, for example `console.sso.terminal_closure_unaudited`) are
 * metric alarms on `vsp_alarm_log_events_total{event}`: the composition wraps every component logger with
 * `alarmLogTap`, which counts those event names (and nothing else) before the event is written, so they are
 * exported with the metrics and alarm the same way. Alarm text is fixed: description and runbook id only.
 */
import { ValidationError } from "../shared/errors.js";
import { ALARM_LOG_EVENTS } from "./composition-catalog.js";
import type { AlarmLogEvent } from "./composition-catalog.js";
import type { MetricCatalogue } from "./metrics.js";
import type { Logger, Metrics, SafeFields } from "./ports.js";

export type AlarmSeverity = "critical" | "high" | "medium";

export interface AlarmRule {
  /** Stable alarm id (kebab case; the Terraform alarm name suffix). */
  readonly id: string;
  readonly description: string;
  readonly runbook: string;
  readonly metric: string;
  /** Label filter: every listed label must equal the value. */
  readonly dims: Readonly<Record<string, string>>;
  readonly statistic: "Sum" | "Maximum" | "Minimum";
  readonly periodSeconds: number;
  readonly evaluationPeriods: number;
  readonly threshold: number;
  readonly operator: "GreaterThanThreshold" | "GreaterThanOrEqualToThreshold" | "LessThanThreshold";
  readonly missing: "breaching" | "notBreaching";
  readonly severity: AlarmSeverity;
}

const logEventRule = (event: AlarmLogEvent, id: string, description: string, runbook: string): AlarmRule => ({
  id,
  description,
  runbook,
  metric: "vsp_alarm_log_events_total",
  dims: { event },
  statistic: "Sum",
  periodSeconds: 60,
  evaluationPeriods: 1,
  threshold: 0,
  operator: "GreaterThanThreshold",
  missing: "notBreaching",
  severity: "critical",
});

/** Alarm rules added by the live composition (WP-39 renders them into infra/terraform/modules/observability). */
export const COMPOSITION_ALARM_RULES: readonly AlarmRule[] = Object.freeze([
  {
    id: "connector-feed-dead-letter-refused",
    description: "A connector change-feed record could not be dead-lettered (dead-letter queue full or unwritable): consumption of that feed stopped and its checkpoint is kept. Runbook RB-DLQ-REPAIR. Restore the dead-letter queue; nothing was dropped.",
    runbook: "RB-DLQ-REPAIR",
    metric: "vsp_connector_feed_dead_letter_refused_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 60,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "critical",
  },
  {
    id: "action-reconcile-degraded",
    description: "The worker found actions in UNKNOWN or stale COMMITTING and could settle none of them for three runs (every provider lookup inconclusive, or no provider for the kind): their outcome stays unknown to callers and staff. Runbook RB-UNKNOWN-COMMIT. Check the provider's health and its lookup, then reconcile manually.",
    runbook: "RB-UNKNOWN-COMMIT",
    metric: "vsp_action_reconcile_degraded_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 900,
    evaluationPeriods: 1,
    threshold: 3,
    operator: "GreaterThanOrEqualToThreshold",
    missing: "notBreaching",
    severity: "high",
  },
  {
    id: "outbox-publish-failures",
    description: "The worker could not publish outbox messages to the queue (publish refused, queue missing or the attempt limit reached): they stay in PostgreSQL, PENDING for a retry or DEAD. Runbook RB-DLQ-REPAIR. Restore the queue or its permissions, then requeue DEAD messages.",
    runbook: "RB-DLQ-REPAIR",
    metric: "vsp_outbox_publish_failures_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 300,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "high",
  },
  {
    id: "outbox-consume-failures",
    description: "The live worker could not consume outbox messages (consumer failure, invalid envelope or no consumer): they stay on the queue and move to its dead-letter queue after the redrive count. Runbook RB-DLQ-REPAIR. Fix the consumer or the producer, then redrive.",
    runbook: "RB-DLQ-REPAIR",
    metric: "vsp_outbox_consume_failures_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 300,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "high",
  },
  {
    id: "capability-guard-port-reached",
    description: "A NOT_CONFIGURED capability was reached past its gate (admission or hold). Runbook RB-ADMISSION. The call failed closed; find the path that skipped the gate.",
    runbook: "RB-ADMISSION",
    metric: "vsp_capability_not_configured_reached_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 60,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "critical",
  },
  {
    id: "telemetry-attribute-dropped",
    description: "An attribute outside the content-free allowlist reached the telemetry exporter and was dropped. Runbook RB-PHI-EXPOSURE. Find the emitter.",
    runbook: "RB-PHI-EXPOSURE",
    metric: "vsp_telemetry_attributes_dropped_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 300,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "high",
  },
  {
    id: "inbox-dead-letter",
    description: "An inbound event moved to INBOUND_DEAD after bounded attempts. Runbook RB-DLQ-REPAIR. Replay after the cause is fixed (audited).",
    runbook: "RB-DLQ-REPAIR",
    metric: "vsp_inbox_dead_letter_total",
    dims: {},
    statistic: "Sum",
    periodSeconds: 60,
    evaluationPeriods: 1,
    threshold: 0,
    operator: "GreaterThanThreshold",
    missing: "notBreaching",
    severity: "high",
  },
  logEventRule(
    "console.sso.terminal_closure_unaudited",
    "console-sso-terminal-closure-unaudited",
    "A console session or recovery custodian was closed without its audit events (audit store refused them). Runbook RB-AUDIT-GAP. Reconstruct the closure from the identity provider and the session table.",
    "RB-AUDIT-GAP",
  ),
  logEventRule(
    "console.sso.terminal_audit_unwritten",
    "console-sso-terminal-audit-unwritten",
    "A console terminal-path audit event could not be written even on its own append. Runbook RB-AUDIT-GAP. Record the event manually from the error log.",
    "RB-AUDIT-GAP",
  ),
  logEventRule(
    "audit.journal.memory_fallback",
    "audit-journal-memory-fallback",
    "Route audit evidence is held in process memory only (PostgreSQL and the independent journal both refused it) and is lost on a crash. Runbook RB-AUDIT-OUTAGE. Restore either journal; do not restart the process.",
    "RB-AUDIT-OUTAGE",
  ),
  logEventRule(
    "audit.journal.lost_at_shutdown",
    "audit-journal-lost-at-shutdown",
    "Route audit evidence reached a sealed journal after shutdown and was lost. Runbook RB-AUDIT-GAP. Document the lost event.",
    "RB-AUDIT-GAP",
  ),
]);

const ALARM_ID = /^[a-z][a-z0-9-]{2,63}$/;

/** Validates rules against the catalogue: metric and dimension values must exist (a typo never silences an alarm). */
export function validateAlarmRules(rules: readonly AlarmRule[], catalogue: MetricCatalogue): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const r of rules) {
    if (!ALARM_ID.test(r.id)) out.push(`ALARM_ID_INVALID@${r.id}`);
    if (ids.has(r.id)) out.push(`ALARM_ID_DUPLICATE@${r.id}`);
    ids.add(r.id);
    const d = catalogue.get(r.metric);
    if (!d) {
      out.push(`ALARM_METRIC_UNKNOWN@${r.id}`);
      continue;
    }
    for (const [k, v] of Object.entries(r.dims)) {
      const allowed = Object.hasOwn(d.labels, k) ? d.labels[k] : undefined;
      if (!allowed || !allowed.includes(v)) out.push(`ALARM_DIMENSION_UNKNOWN@${r.id}.${k}`);
    }
    if (!Number.isInteger(r.periodSeconds) || r.periodSeconds < 10 || !Number.isInteger(r.evaluationPeriods) || r.evaluationPeriods < 1) out.push(`ALARM_WINDOW_INVALID@${r.id}`);
  }
  return out;
}

/** One observed value of a metric series inside an evaluation period (counter delta, gauge value). */
export interface AlarmSample {
  metric: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

export interface AlarmEvaluation {
  alarmId: string;
  state: "ALARM" | "OK";
  /** The statistic over the matching samples, or null when no sample matched (missing data). */
  observed: number | null;
  missingData: boolean;
}

/** Evaluates one period of a rule (the composition tests and fault runs feed one period of samples). */
export function evaluateAlarm(rule: AlarmRule, samples: readonly AlarmSample[]): AlarmEvaluation {
  const matching = samples.filter((s) => s.metric === rule.metric && Object.entries(rule.dims).every(([k, v]) => s.labels[k] === v)).map((s) => s.value);
  if (matching.length === 0) return { alarmId: rule.id, state: rule.missing === "breaching" ? "ALARM" : "OK", observed: null, missingData: true };
  const observed = rule.statistic === "Sum" ? matching.reduce((a, b) => a + b, 0) : rule.statistic === "Maximum" ? Math.max(...matching) : Math.min(...matching);
  const breaching =
    rule.operator === "GreaterThanThreshold" ? observed > rule.threshold : rule.operator === "GreaterThanOrEqualToThreshold" ? observed >= rule.threshold : observed < rule.threshold;
  return { alarmId: rule.id, state: breaching ? "ALARM" : "OK", observed, missingData: false };
}

export function alarmRule(id: string, rules: readonly AlarmRule[] = COMPOSITION_ALARM_RULES): AlarmRule {
  const r = rules.find((x) => x.id === id);
  if (!r) throw new ValidationError("ALARM_RULE_UNKNOWN");
  return r;
}

const ALARM_EVENT_SET: ReadonlySet<string> = new Set(ALARM_LOG_EVENTS);

/**
 * Logger decorator: counts every alarm log event (by its code-constant name, nothing else) in
 * vsp_alarm_log_events_total before writing it through. Fields are passed through unchanged to the inner,
 * content-free logger. A metrics failure never suppresses the log line.
 */
export function alarmLogTap(inner: Logger, metrics: Metrics): Logger {
  const count = (event: string): void => {
    if (!ALARM_EVENT_SET.has(event)) return;
    try {
      metrics.increment("vsp_alarm_log_events_total", { event });
    } catch {
      // the log line below is still written
    }
  };
  const wrap = (l: Logger): Logger => ({
    debug: (e: string, f?: SafeFields) => l.debug(e, f),
    info: (e: string, f?: SafeFields) => l.info(e, f),
    warn: (e: string, f?: SafeFields) => {
      count(e);
      l.warn(e, f);
    },
    error: (e: string, f?: SafeFields) => {
      count(e);
      l.error(e, f);
    },
    child: (b: SafeFields) => wrap(l.child(b)),
  });
  return wrap(inner);
}
