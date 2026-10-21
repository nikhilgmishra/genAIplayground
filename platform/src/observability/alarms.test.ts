/**
 * Alarm rules as code (WP-07; FO-03-30, FO-17-24.DLQ_FULL, OPS-01): every rule names a catalogue metric and
 * catalogue dimension values, the evaluator applies the statistic, threshold and missing-data treatment, and
 * the logger tap turns paging log events into the metric their rule watches.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALARM_LOG_EVENTS } from "./composition-catalog.js";
import { PLATFORM_METRIC_CATALOGUE } from "./catalog/index.js";
import { COMPOSITION_ALARM_RULES, alarmLogTap, alarmRule, evaluateAlarm, validateAlarmRules } from "./alarms.js";
import { createMemoryLogger } from "./logger.js";
import { InMemoryMetrics } from "./metrics.js";

describe("composition alarm rules [FO-03-30][OPS-01]", () => {
  it("[FO-03-30] every rule resolves against the merged catalogue (metric and dimension values)", () => {
    expect(validateAlarmRules(COMPOSITION_ALARM_RULES, PLATFORM_METRIC_CATALOGUE)).toEqual([]);
    expect(validateAlarmRules([{ ...alarmRule("inbox-dead-letter"), metric: "vsp_inbox_dead_letters_total" }], PLATFORM_METRIC_CATALOGUE)).toEqual(["ALARM_METRIC_UNKNOWN@inbox-dead-letter"]);
    expect(validateAlarmRules([{ ...alarmRule("console-sso-terminal-closure-unaudited"), dims: { event: "console.sso.typo" } }], PLATFORM_METRIC_CATALOGUE)).toEqual(["ALARM_DIMENSION_UNKNOWN@console-sso-terminal-closure-unaudited.event"]);
  });

  it("[OPS-01] every rule names, in its text and its field, a runbook id the runbook index lists", () => {
    const index = readFileSync(new URL("../../../docs/RUNBOOKS/README.md", import.meta.url), "utf8");
    for (const rule of COMPOSITION_ALARM_RULES) {
      expect(rule.description, rule.id).toContain(`Runbook ${rule.runbook}.`);
      expect(index, `${rule.id} ${rule.runbook}`).toMatch(new RegExp(`\\b${rule.runbook}\\b`));
      expect(index, `${rule.id} in the alarm map`).toContain(`\`${rule.id}\``);
    }
  });

  it("[FO-17-24.DLQ_FULL] the dead-letter-refused rule fires on one refusal and stays OK on missing data", () => {
    const rule = alarmRule("connector-feed-dead-letter-refused");
    expect(evaluateAlarm(rule, [])).toEqual({ alarmId: rule.id, state: "OK", observed: null, missingData: true });
    expect(evaluateAlarm(rule, [{ metric: "vsp_connector_feed_dead_letter_refused_total", labels: {}, value: 0 }]).state).toBe("OK");
    expect(evaluateAlarm(rule, [{ metric: "vsp_connector_feed_dead_letter_refused_total", labels: {}, value: 1 }])).toMatchObject({ state: "ALARM", observed: 1 });
    // A breaching-on-missing rule alarms when nothing reports (silence is not health).
    expect(evaluateAlarm({ ...rule, missing: "breaching" }, []).state).toBe("ALARM");
    expect(evaluateAlarm({ ...rule, operator: "LessThanThreshold", threshold: 1, statistic: "Minimum" }, [{ metric: rule.metric, labels: {}, value: 0 }]).state).toBe("ALARM");
  });

  it("[OPS-01] the logger tap counts paging log events (console.sso.terminal_closure_unaudited, terminal_audit_unwritten) and only those; the line is still written", () => {
    const metrics = new InMemoryMetrics({ catalogue: PLATFORM_METRIC_CATALOGUE });
    const mem = createMemoryLogger();
    const log = alarmLogTap(mem.logger, metrics).child({ component: "console_api" });
    log.error("console.sso.terminal_closure_unaudited", { reasonCode: "AUDIT_UNAVAILABLE" });
    log.error("console.sso.terminal_audit_unwritten", { reasonCode: "AUDIT_UNAVAILABLE" });
    log.error("console.sso.some_other_error", { reasonCode: "X_FAILED" });
    log.info("console.sso.terminal_closure_unaudited");
    expect(mem.records.map((r) => r.event)).toEqual(["console.sso.terminal_closure_unaudited", "console.sso.terminal_audit_unwritten", "console.sso.some_other_error", "console.sso.terminal_closure_unaudited"]);
    expect(metrics.counterValue("vsp_alarm_log_events_total", { event: "console.sso.terminal_closure_unaudited" })).toBe(1);
    expect(metrics.counterValue("vsp_alarm_log_events_total", { event: "console.sso.terminal_audit_unwritten" })).toBe(1);
    expect(metrics.counterValue("vsp_alarm_log_events_total")).toBe(2);
    const samples = metrics.find("vsp_alarm_log_events_total").map((s) => ({ metric: s.name, labels: s.labels, value: s.value }));
    expect(evaluateAlarm(alarmRule("console-sso-terminal-closure-unaudited"), samples).state).toBe("ALARM");
    expect(evaluateAlarm(alarmRule("audit-journal-memory-fallback"), samples).state).toBe("OK");
    expect(new Set(ALARM_LOG_EVENTS).size).toBe(ALARM_LOG_EVENTS.length);
  });

  it("[OPS-01] failure: a throwing metrics sink never suppresses the paging log line", () => {
    const mem = createMemoryLogger();
    const log = alarmLogTap(mem.logger, { increment: () => { throw new Error("sink down"); }, observe: () => undefined, gauge: () => undefined });
    log.error("audit.journal.memory_fallback", { reasonCode: "AUDIT_JOURNALS_REFUSED" });
    expect(mem.records).toHaveLength(1);
  });
});
