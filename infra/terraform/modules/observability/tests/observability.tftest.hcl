# [SPEC-13.dashboards] [SPEC-13.alerts] [DATA-01] Dashboards for the spec section 13
# list and alarms for tool P95, safety route initiation, unknown commits, audit
# backlog / ingestion gap, deferred route-audit depth and drops, accepted consequential
# calls without audit, verification abuse, CRM lag, 5xx rate, budget burn, admission
# rejections and the count-only edge rate rule. Alarm text contains no PHI.
# Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix               = "vsp-test"
  account_id                = "111111111111"
  region                    = "us-east-1"
  messaging_kms_key_arn     = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000009"
  logs_kms_key_arn          = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
  log_retention_days        = 30
  alb_arn_suffix            = "app/vsp-test-ingress/0123456789abcdef"
  target_group_arn_suffix   = "targetgroup/vsp-test-gateway/0123456789abcdef"
  ecs_cluster_name          = "vsp-test-cluster"
  ecs_service_names         = { gateway = "gateway", worker = "worker" }
  aurora_cluster_identifier = "vsp-test-ledger"
  sessions_table_name       = "vsp-test-sessions"
  queue_names               = { crm-sync = "vsp-test-crm-sync.fifo" }
}

run "dashboards_and_alarms" {
  command = plan

  assert {
    condition = alltrue([for d in ["call-flow", "identity", "tools-dependencies", "safety", "crm-reconciliation", "knowledge", "voice-experience", "cost-quotas", "audit", "admission-controls", "platform"] :
    contains(keys(aws_cloudwatch_dashboard.this), d)])
    error_message = "[SPEC-13.dashboards] one dashboard per spec section 13 area"
  }

  assert {
    condition = alltrue([for a in ["tool-latency-p95", "safety-route-initiation", "unknown-commits", "audit-backlog-not-draining", "audit-ingestion-gap", "crm-sync-lag", "budget-burn", "admission-rejections"] :
    contains(keys(aws_cloudwatch_metric_alarm.app), a)])
    error_message = "[SPEC-13.alerts] required alert rules exist"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["tool-latency-p95"].extended_statistic == "p95" && aws_cloudwatch_metric_alarm.app["tool-latency-p95"].threshold == 3000
    error_message = "tool latency alarm uses P95 against the proposed 3 s target"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["safety-route-initiation"].threshold == 2000
    error_message = "safety route alarm uses the 2 s engineering target"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["unknown-commits"].threshold == 0 && aws_cloudwatch_metric_alarm.app["audit-ingestion-gap"].threshold == 0
    error_message = "zero-tolerance alarms fire on the first event"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["audit-export-incomplete"].treat_missing_data == "breaching"
    error_message = "[OPS-03] missing audit telemetry is treated as a gap, not a pass"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["audit-ingestion-gap"].treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.app["audit-ingestion-gap"].metric_name == "vsp_audit_ingestion_gaps_total"
    error_message = "[OPS-01][OPS-AUD-01] the critical audit-ingestion-gap alarm fires when audit verification stops reporting (missing data is breaching)"
  }

  assert {
    condition = alltrue([for a in values(aws_cloudwatch_metric_alarm.app) :
    !can(regex("[0-9]{3}-[0-9]{3}-[0-9]{4}|@|\\$\\{|date of birth|DOB|SSN", a.alarm_description))])
    error_message = "[DATA-01] alarm text contains no PHI, identifiers or interpolated labels"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.app) : can(regex("Runbook RB-[A-Z-]+", a.alarm_description))])
    error_message = "every alarm points at a runbook"
  }

  assert {
    condition     = aws_sns_topic.alarms.kms_master_key_id == var.messaging_kms_key_arn
    error_message = "[SPEC-6.encryption] alarm topic is KMS encrypted"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].metric_name == "vsp_audit_deferred_depth" &&
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].threshold == 0 &&
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].evaluation_periods * aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].period >= 300 &&
      aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].datapoints_to_alarm == aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].evaluation_periods &&
      can(regex("Runbook RB-AUDIT-OUTAGE", aws_cloudwatch_metric_alarm.app["audit-deferred-depth"].alarm_description))
    )
    error_message = "[OPS-01][OPS-02] route evidence held in a process-local deferred queue (lost on a crash) for a sustained period alarms, worst process first (ADR-0011)"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["audit-deferred-dropped"].metric_name == "vsp_audit_deferred_total" && aws_cloudwatch_metric_alarm.app["audit-deferred-dropped"].dimensions == tomap({ result = "dropped" }) && aws_cloudwatch_metric_alarm.app["audit-deferred-dropped"].threshold == 0 && aws_cloudwatch_metric_alarm.app["audit-deferred-dropped"].alarm_description == "[CRITICAL] A handoff route audit event was dropped (deferred queue full, the event was refused as invalid, or it reached the queue after a graceful shutdown sealed it); that route evidence is lost. Runbook RB-AUDIT-GAP. Document every dropped event."
    error_message = "[OPS-01] a dropped deferred route-audit event is critical (evidence lost)"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.app["verification-abuse-signals"].metric_name == "vsp_verification_abuse_signals_total" && aws_cloudwatch_metric_alarm.app["verification-abuse-signals"].threshold == 0 && can(regex("Runbook RB-AUTH-BYPASS", aws_cloudwatch_metric_alarm.app["verification-abuse-signals"].alarm_description))
    error_message = "[AUTH-03][AUTH-ENUM-01] verification abuse signals alarm into the authentication-bypass runbook"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.threshold == 0 &&
      aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.comparison_operator == "GreaterThanThreshold" &&
      length([for q in aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.metric_query : q if q.return_data == true]) == 1 &&
      toset([for q in aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.metric_query : q.metric[0].dimensions["audit"] if length(q.metric) > 0]) == toset(["not_recorded", "recorded_before_ack"]) &&
      alltrue([for q in aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.metric_query : q.metric[0].metric_name == "vsp_protected_actions_total" && q.metric[0].namespace == "VSP" if length(q.metric) > 0]) &&
      can(regex("^100 \\* FILL\\(notrecorded, 0\\) / ", one([for q in aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.metric_query : q.expression if q.return_data == true])))
    )
    error_message = "[OPS-01][SPEC-13.alerts] the not_recorded share of accepted consequential tool calls (objective audited_accepted_actions) alarms on the first one"
  }

  assert {
    condition     = can(regex("Runbook RB-AUDIT-GAP", aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.alarm_description)) && !can(regex("[0-9]{3}-[0-9]{3}-[0-9]{4}|@|\\$\\{|date of birth|DOB|SSN", aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.alarm_description))
    error_message = "[DATA-01] the ratio alarm points at a runbook and its text contains no PHI"
  }

  assert {
    condition     = contains(output.catalogue_metric_names, "vsp_audit_deferred_depth") && contains(output.catalogue_metric_names, "vsp_protected_actions_total") && contains(output.catalogue_metric_names, "vsp_verification_abuse_signals_total")
    error_message = "the new alarm metrics are exported for the catalogue drift check"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.waf_tool_path_rate) == 0
    error_message = "no WAF alarm without the web ACL and rule metric names"
  }

  assert {
    condition     = contains(output.catalogue_metric_names, "vsp_tool_latency_ms") && contains(output.catalogue_metric_names, "vsp_unknown_commits_total")
    error_message = "catalogue metric names are exported for the drift check"
  }

  assert {
    condition     = can(regex("NOT VERIFIED", jsondecode(local.dashboard_bodies["safety"]).widgets[0].properties.markdown))
    error_message = "[OPS-03] dashboards state that the telemetry path is not verified"
  }
}

run "waf_tool_path_rate_alarm" {
  command = plan

  variables {
    waf_web_acl_name             = "vsp-test-ingress"
    waf_rate_observe_metric_name = "vsp-test-rate-observe-tool-paths"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.waf_tool_path_rate[0].namespace == "AWS/WAFV2" &&
      aws_cloudwatch_metric_alarm.waf_tool_path_rate[0].metric_name == "CountedRequests" &&
      aws_cloudwatch_metric_alarm.waf_tool_path_rate[0].dimensions == tomap({ WebACL = "vsp-test-ingress", Rule = "vsp-test-rate-observe-tool-paths", Region = "us-east-1" }) &&
      aws_cloudwatch_metric_alarm.waf_tool_path_rate[0].threshold == 0 &&
      can(regex("Runbook RB-DEPENDENCY-OUTAGE", aws_cloudwatch_metric_alarm.waf_tool_path_rate[0].alarm_description))
    )
    error_message = "[SAFE-03] the count-only edge rate rule on the tool-caller paths is observed by an alarm (it never blocks)"
  }

  assert {
    condition     = contains(output.alarm_names, "vsp-test-waf-tool-path-rate-observed") && contains(output.alarm_names, "vsp-test-audit-not-recorded-ratio")
    error_message = "alarm names include the metric-math and WAF alarms"
  }
}
