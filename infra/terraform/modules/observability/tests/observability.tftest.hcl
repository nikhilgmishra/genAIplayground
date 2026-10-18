# [SPEC-13.dashboards] [SPEC-13.alerts] [DATA-01] Dashboards for the spec section 13
# list and alarms for tool P95, safety route initiation, unknown commits, audit
# backlog / ingestion gap, CRM lag, 5xx rate, budget burn and admission rejections.
# Alarm text contains no PHI. Offline: mock provider, plan only.

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
    condition     = contains(output.catalogue_metric_names, "vsp_tool_latency_ms") && contains(output.catalogue_metric_names, "vsp_unknown_commits_total")
    error_message = "catalogue metric names are exported for the drift check"
  }

  assert {
    condition     = can(regex("NOT VERIFIED", jsondecode(local.dashboard_bodies["safety"]).widgets[0].properties.markdown))
    error_message = "[OPS-03] dashboards state that the telemetry path is not verified"
  }
}
