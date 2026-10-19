# Operational dashboards and alert rules (spec section 13) over the platform's
# content-free metric catalogue (platform/src/observability/metrics.ts) plus AWS
# service metrics. Alarm names and descriptions are fixed text with runbook ids:
# they never interpolate labels, identifiers or payloads (no PHI in alert text).
# Alarms notify a KMS-encrypted SNS topic; subscriptions (paging) are BLOCKED on the
# SRE on-call roster and an approved paging integration.

locals {
  ns = var.metrics_namespace

  banner = join("\n", [
    "## ${var.name_prefix}",
    "Application series come from the OpenTelemetry metric catalogue (closed label enums, no PHI).",
    "**Status: NOT VERIFIED** - the OTel to CloudWatch export is BLOCKED pending approval; empty panels are not evidence of health.",
    "Targets shown in alarms are PROPOSED (spec section 13) or engineering proposals, not measured capabilities.",
  ])

  # ------------------------------------------------------------------ dashboards
  # Each widget: title + rows of [namespace, metric, dim, value, ...] with a stat.
  dashboards = {
    call-flow = [
      { title = "Call arrivals", rows = [{ m = [local.ns, "vsp_call_arrivals_total"], stat = "Sum" }] },
      { title = "Live sessions", rows = [{ m = [local.ns, "vsp_live_sessions"], stat = "Maximum" }] },
      { title = "Queue age p95 (ms)", rows = [{ m = [local.ns, "vsp_queue_age_ms"], stat = "p95" }] },
      { title = "Abandonment", rows = [{ m = [local.ns, "vsp_abandonments_total"], stat = "Sum" }] },
      { title = "Human demand", rows = [{ m = [local.ns, "vsp_human_demand_total"], stat = "Sum" }] },
      { title = "Transfers and disconnects", rows = [{ m = [local.ns, "vsp_transfers_total"], stat = "Sum" }, { m = [local.ns, "vsp_disconnects_total"], stat = "Sum" }] },
      { title = "Routing to a usable path", rows = [{ m = [local.ns, "vsp_routing_outcomes_total", "routing_result", "usable_path"], stat = "Sum" }, { m = [local.ns, "vsp_routing_outcomes_total", "routing_result", "no_usable_path"], stat = "Sum" }] },
      { title = "Interaction outcomes", rows = [{ m = [local.ns, "vsp_interaction_outcomes_total"], stat = "Sum" }] },
    ]
    identity = [
      { title = "Verification attempts", rows = [{ m = [local.ns, "vsp_identity_verifications_total"], stat = "Sum" }] },
      { title = "Verification failures", rows = [{ m = [local.ns, "vsp_identity_verifications_total", "result", "failure"], stat = "Sum" }, { m = [local.ns, "vsp_identity_verifications_total", "result", "locked"], stat = "Sum" }] },
      { title = "Challenge abuse signals", rows = [{ m = [local.ns, "vsp_challenge_abuse_signals_total"], stat = "Sum" }] },
      { title = "Verification abuse signals (account monitor)", rows = [{ m = [local.ns, "vsp_verification_abuse_signals_total"], stat = "Sum" }] },
      { title = "Denials", rows = [{ m = [local.ns, "vsp_identity_denials_total"], stat = "Sum" }] },
    ]
    tools-dependencies = [
      { title = "Tool latency (ms)", rows = [{ m = [local.ns, "vsp_tool_latency_ms"], stat = "p50" }, { m = [local.ns, "vsp_tool_latency_ms"], stat = "p95" }, { m = [local.ns, "vsp_tool_latency_ms"], stat = "p99" }] },
      { title = "Tool calls", rows = [{ m = [local.ns, "vsp_tool_calls_total"], stat = "Sum" }] },
      { title = "Dependency errors", rows = [{ m = [local.ns, "vsp_dependency_errors_total"], stat = "Sum" }] },
      { title = "Unknown commits (reconcile before retry)", rows = [{ m = [local.ns, "vsp_unknown_commits_total"], stat = "Sum" }] },
      { title = "Backlogs", rows = [{ m = [local.ns, "vsp_backlog_items"], stat = "Maximum" }] },
      { title = "Duplicate effects (target zero)", rows = [{ m = [local.ns, "vsp_duplicate_effects_total"], stat = "Sum" }] },
    ]
    safety = [
      { title = "Safety signals", rows = [{ m = [local.ns, "vsp_safety_signals_total"], stat = "Sum" }] },
      { title = "Time to priority route (ms)", rows = [{ m = [local.ns, "vsp_safety_time_to_routing_ms"], stat = "p95" }, { m = [local.ns, "vsp_safety_time_to_routing_ms"], stat = "Maximum" }] },
      { title = "Safety handoffs completed", rows = [{ m = [local.ns, "vsp_safety_handoffs_total", "result", "completed"], stat = "Sum" }] },
      { title = "Safety handoffs failed / receiver unavailable", rows = [{ m = [local.ns, "vsp_safety_handoffs_total", "result", "failed"], stat = "Sum" }, { m = [local.ns, "vsp_safety_handoffs_total", "result", "receiver_unavailable"], stat = "Sum" }] },
      { title = "Unsupported clinical requests", rows = [{ m = [local.ns, "vsp_unsupported_clinical_requests_total"], stat = "Sum" }] },
      { title = "Boundary violations (zero tolerance)", rows = [{ m = [local.ns, "vsp_boundary_violations_total"], stat = "Sum" }] },
    ]
    crm-reconciliation = [
      { title = "CRM reconciliation", rows = [{ m = [local.ns, "vsp_crm_reconciliation_total"], stat = "Sum" }] },
      { title = "CRM sync lag p99.9 (ms)", rows = [{ m = [local.ns, "vsp_crm_sync_lag_ms"], stat = "p99.9" }] },
      { title = "Queue oldest message age (s)", rows = [for k, q in var.queue_names : { m = ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", q], stat = "Maximum" }] },
    ]
    knowledge = [
      { title = "Oldest approved item age (s)", rows = [{ m = [local.ns, "vsp_knowledge_freshness_age_seconds"], stat = "Maximum" }] },
      { title = "Items needing review", rows = [{ m = [local.ns, "vsp_knowledge_items_needing_review"], stat = "Maximum" }] },
    ]
    voice-experience = [
      { title = "Turn latency (ms)", rows = [{ m = [local.ns, "vsp_turn_latency_ms"], stat = "p50" }, { m = [local.ns, "vsp_turn_latency_ms"], stat = "p95" }] },
      { title = "Barge-in stop p95 (ms)", rows = [{ m = [local.ns, "vsp_barge_in_stop_ms"], stat = "p95" }] },
      { title = "Interruptions", rows = [{ m = [local.ns, "vsp_interruptions_total"], stat = "Sum" }] },
    ]
    cost-quotas = [
      { title = "Spend (USD micro-units)", rows = [{ m = [local.ns, "vsp_cost_usd_micro_total"], stat = "Sum" }] },
      { title = "Budget utilization", rows = [{ m = [local.ns, "vsp_budget_utilization_ratio"], stat = "Maximum" }] },
      { title = "Quota utilization", rows = [{ m = [local.ns, "vsp_quota_utilization_ratio"], stat = "Maximum" }] },
      { title = "Safety reserve overdraw (alert, never a cap)", rows = [{ m = [local.ns, "vsp_safety_reserve_overdraw_total"], stat = "Sum" }] },
    ]
    audit = [
      { title = "Audit export completeness", rows = [{ m = [local.ns, "vsp_audit_export_completeness_ratio"], stat = "Minimum" }] },
      { title = "Audit backlog", rows = [{ m = [local.ns, "vsp_audit_backlog_events"], stat = "Maximum" }] },
      { title = "Audit ingestion gaps", rows = [{ m = [local.ns, "vsp_audit_ingestion_gaps_total"], stat = "Sum" }] },
      { title = "Protected actions without decision or audit", rows = [{ m = [local.ns, "vsp_protected_actions_total", "authorization", "missing_decision"], stat = "Sum" }, { m = [local.ns, "vsp_protected_actions_total", "audit", "not_recorded"], stat = "Sum" }] },
      { title = "Deferred route audit (process-local; lost on a crash)", rows = [{ m = [local.ns, "vsp_audit_deferred_depth"], stat = "Maximum" }, { m = [local.ns, "vsp_audit_deferred_total", "result", "dropped"], stat = "Sum" }] },
    ]
    admission-controls = [
      { title = "Admission rejections", rows = [{ m = [local.ns, "vsp_admission_decisions_total", "admitted", "false"], stat = "Sum" }] },
      { title = "Active AI sessions", rows = [{ m = [local.ns, "vsp_ai_sessions_active"], stat = "Maximum" }] },
      { title = "Kill switches engaged", rows = [{ m = [local.ns, "vsp_killswitch_engaged"], stat = "Maximum" }] },
    ]
    platform = concat(
      [
        { title = "ALB requests", rows = [{ m = ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix], stat = "Sum" }] },
        { title = "ALB 5xx", rows = [{ m = ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", var.alb_arn_suffix], stat = "Sum" }, { m = ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix], stat = "Sum" }] },
        { title = "Target response time p95 (s)", rows = [{ m = ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix], stat = "p95" }] },
        { title = "Healthy gateway targets", rows = [{ m = ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix], stat = "Minimum" }] },
        { title = "Aurora CPU and connections", rows = [{ m = ["AWS/RDS", "CPUUtilization", "DBClusterIdentifier", var.aurora_cluster_identifier], stat = "Maximum" }, { m = ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", var.aurora_cluster_identifier], stat = "Maximum" }] },
        { title = "Session table throttles", rows = [{ m = ["AWS/DynamoDB", "ThrottledRequests", "TableName", var.sessions_table_name], stat = "Sum" }] },
      ],
      [for k, s in var.ecs_service_names : { title = "ECS ${k} CPU / memory", rows = [{ m = ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", s], stat = "Maximum" }, { m = ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", s], stat = "Maximum" }] }],
    )
  }

  dashboard_bodies = {
    for name, widgets in local.dashboards : name => jsonencode({
      widgets = concat(
        [{ type = "text", x = 0, y = 0, width = 24, height = 4, properties = { markdown = local.banner } }],
        [for i, w in widgets : {
          type   = "metric"
          x      = (i % 2) * 12
          y      = 4 + floor(i / 2) * 6
          width  = 12
          height = 6
          properties = {
            title   = w.title
            region  = var.region
            view    = "timeSeries"
            stacked = false
            period  = 300
            metrics = [for r in w.rows : concat(r.m, [{ stat = r.stat }])]
          }
        }],
      )
    })
  }

  # ------------------------------------------------------------------ alarms
  alarms = {
    tool-latency-p95 = {
      description = "Tool-backed response P95 above the proposed target for 15 minutes. Runbook RB-TOOL-LATENCY."
      metric      = "vsp_tool_latency_ms"
      dims        = {}
      stat        = "p95"
      period      = 300
      evaluations = 3
      threshold   = var.tool_p95_threshold_ms
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "high"
    }
    safety-route-initiation = {
      description = "A validated safety event took longer than the engineering target to initiate the priority route. Runbook RB-SAFETY-ROUTE. Page the safety responder on-call."
      metric      = "vsp_safety_time_to_routing_ms"
      dims        = {}
      stat        = "Maximum"
      period      = 60
      evaluations = 1
      threshold   = var.safety_route_threshold_ms
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "critical"
    }
    safety-handoff-failed = {
      description = "A safety handoff failed. Runbook RB-FAILED-SAFETY-TRANSFER. Page the safety responder on-call."
      metric      = "vsp_safety_handoffs_total"
      dims        = { result = "failed" }
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "critical"
    }
    unknown-commits = {
      description = "A commit outcome is UNKNOWN and must be reconciled before any retry or success message. Runbook RB-UNKNOWN-COMMIT."
      metric      = "vsp_unknown_commits_total"
      dims        = {}
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "high"
    }
    duplicate-effects = {
      description = "A duplicate consequential effect was detected. Runbook RB-DUPLICATE-COMMIT. Contain the affected integration."
      metric      = "vsp_duplicate_effects_total"
      dims        = {}
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "critical"
    }
    boundary-violation = {
      description = "A privacy or clinical-boundary violation was recorded. Runbook RB-UNSAFE-OUTPUT. Contain the affected automation."
      metric      = "vsp_boundary_violations_total"
      dims        = {}
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "critical"
    }
    audit-backlog-not-draining = {
      description = "The audit shipping backlog has not drained to zero for 15 minutes. Runbook RB-AUDIT-OUTAGE. Consequential actions block when the bounded buffer is exceeded."
      metric      = "vsp_audit_backlog_events"
      dims        = {}
      stat        = "Minimum"
      period      = 300
      evaluations = 3
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "breaching"
      severity    = "high"
    }
    audit-ingestion-gap = {
      # OPS-AUD-01: the worker loop audit.verify (platform/src/audit/monitor.ts) emits this counter every
      # run (0 = heartbeat), so missing data means verification is not running: breaching, not silence.
      description = "Audit integrity or completeness finding (sequence gap, rewritten or missing row, committed action without audit evidence), or audit verification not reporting. Runbook RB-AUDIT-GAP. Preserve evidence and reconcile source counts."
      metric      = "vsp_audit_ingestion_gaps_total"
      dims        = {}
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "breaching"
      severity    = "critical"
    }
    audit-deferred-depth = {
      # ADR-0011: handoff (route) audit events deferred during an audit outage wait in a process-local queue
      # and are lost if that process crashes or restarts. Every flush run (worker loop audit.deferred_flush
      # and the gateway's own DeferredAuditFlushTimer, every 5 s) reports the depth, 0 included. Maximum over
      # the processes: any process still holding events after 5 minutes alarms. ENGINEERING PROPOSAL (PRQ-011).
      description = "Handoff route audit events have waited in a process-local deferred queue for 5 minutes and are lost if that process restarts. Runbook RB-AUDIT-OUTAGE. Restore audit writes; do not restart the process holding the queue."
      metric      = "vsp_audit_deferred_depth"
      dims        = {}
      stat        = "Maximum"
      period      = 60
      evaluations = 5
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "high"
    }
    audit-deferred-dropped = {
      description = "A handoff route audit event was dropped (deferred queue full, or the event was refused as invalid); that route evidence is lost. Runbook RB-AUDIT-GAP. Document every dropped event."
      metric      = "vsp_audit_deferred_total"
      dims        = { result = "dropped" }
      stat        = "Sum"
      period      = 60
      evaluations = 1
      threshold   = 0
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "critical"
    }
    verification-abuse-signals = {
      # Account-keyed verification abuse signals (ADR-0014; hashed keys stay in the abuse monitor, never in
      # labels). The threshold is an ENGINEERING PROPOSAL pending security operations review.
      description = "Verification abuse signals above the configured count in 5 minutes (possible enumeration or OTP guessing across calls). Runbook RB-AUTH-BYPASS. Never add a reaction that only real accounts trigger."
      metric      = "vsp_verification_abuse_signals_total"
      dims        = {}
      stat        = "Sum"
      period      = 300
      evaluations = 1
      threshold   = var.verification_abuse_signal_threshold
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "high"
    }
    audit-export-incomplete = {
      description = "Audit export completeness below 1 (or not reported) for 15 minutes. Runbook RB-AUDIT-GAP."
      metric      = "vsp_audit_export_completeness_ratio"
      dims        = {}
      stat        = "Minimum"
      period      = 300
      evaluations = 3
      threshold   = 1
      operator    = "LessThanThreshold"
      missing     = "breaching"
      severity    = "high"
    }
    crm-sync-lag = {
      description = "CRM synchronization p99.9 lag above the proposed target for 15 minutes. Runbook RB-CRM-RECONCILE."
      metric      = "vsp_crm_sync_lag_ms"
      dims        = {}
      stat        = "p99.9"
      period      = 300
      evaluations = 3
      threshold   = var.crm_sync_threshold_ms
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "medium"
    }
    budget-burn = {
      description = "Projected spend crossed the configured fraction of budget. Runbook RB-UNEXPECTED-SPEND. Alerts are not hard caps; safety routes are never cut off."
      metric      = "vsp_budget_utilization_ratio"
      dims        = {}
      stat        = "Maximum"
      period      = 300
      evaluations = 1
      threshold   = var.budget_burn_ratio
      operator    = "GreaterThanOrEqualToThreshold"
      missing     = "notBreaching"
      severity    = "medium"
    }
    admission-rejections = {
      description = "Admission control rejected requests and routed callers to continuity service. Runbook RB-ADMISSION."
      metric      = "vsp_admission_decisions_total"
      dims        = { admitted = "false" }
      stat        = "Sum"
      period      = 300
      evaluations = 1
      threshold   = var.admission_rejection_threshold
      operator    = "GreaterThanThreshold"
      missing     = "notBreaching"
      severity    = "medium"
    }
  }

  # Catalogue metrics read by the metric-math alarms below (exported for the drift check).
  math_alarm_metrics = ["vsp_protected_actions_total"]
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = var.messaging_kms_key_arn

  tags = var.tags
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudWatchAlarmsAndBudgetsPublish"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alarms.arn
        Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alarms.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "metrics" {
  name                        = "/vsp/${var.name_prefix}/metrics"
  retention_in_days           = var.log_retention_days
  kms_key_id                  = var.logs_kms_key_arn
  deletion_protection_enabled = true

  tags = merge(var.tags, { "vsp:data-class" = "OPERATIONAL_TELEMETRY" })
}

resource "aws_cloudwatch_dashboard" "this" {
  for_each = local.dashboard_bodies

  dashboard_name = "${var.name_prefix}-${each.key}"
  dashboard_body = each.value
}

resource "aws_cloudwatch_metric_alarm" "app" {
  for_each = local.alarms

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = "[${upper(each.value.severity)}] ${each.value.description}"
  namespace           = local.ns
  metric_name         = each.value.metric
  dimensions          = length(each.value.dims) == 0 ? null : each.value.dims
  statistic           = startswith(each.value.stat, "p") ? null : each.value.stat
  extended_statistic  = startswith(each.value.stat, "p") ? each.value.stat : null
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.evaluations
  threshold           = each.value.threshold
  comparison_operator = each.value.operator
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  tags = merge(var.tags, { "vsp:severity" = each.value.severity })
}

resource "aws_cloudwatch_metric_alarm" "http_5xx_rate" {
  alarm_name          = "${var.name_prefix}-ingress-5xx-rate"
  alarm_description   = "[HIGH] Ingress 5xx rate above the configured percentage for 10 minutes. Runbook RB-DEPENDENCY-OUTAGE. Studio's independent human route is unaffected."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.http_5xx_rate_percent
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "rate"
    expression  = "100 * (FILL(elb5xx, 0) + FILL(target5xx, 0)) / IF(FILL(requests, 0) > 0, requests, 1)"
    label       = "5xx percent"
    return_data = true
  }

  metric_query {
    id = "elb5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "target5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 300
    }
  }

  tags = merge(var.tags, { "vsp:severity" = "high" })
}

# OPS-01, objective audited_accepted_actions (platform/src/observability/slo.ts; PROPOSED target: every
# accepted consequential action durably audited before acknowledgment). The gateway pipeline counts an
# accepted consequential tool call (SUCCESS or PENDING) whose tool.invoke audit append failed as
# vsp_protected_actions_total{audit="not_recorded"}, else {audit="recorded_before_ack"}. The ratio uses
# the single-dimension `audit` series of the export contract (summed over the authorization label).
resource "aws_cloudwatch_metric_alarm" "audit_not_recorded_ratio" {
  alarm_name          = "${var.name_prefix}-audit-not-recorded-ratio"
  alarm_description   = "[CRITICAL] Accepted consequential tool calls without a recorded tool.invoke audit event above the configured percentage (objective: none). Runbook RB-AUDIT-GAP. Reconcile the affected actions against the ledger; consider engaging WRITES."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.audit_not_recorded_percent
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "ratio"
    expression  = "100 * FILL(notrecorded, 0) / IF(FILL(notrecorded, 0) + FILL(recorded, 0) > 0, FILL(notrecorded, 0) + FILL(recorded, 0), 1)"
    label       = "not recorded percent"
    return_data = true
  }

  metric_query {
    id = "notrecorded"
    metric {
      namespace   = local.ns
      metric_name = "vsp_protected_actions_total"
      dimensions  = { audit = "not_recorded" }
      stat        = "Sum"
      period      = 60
    }
  }

  metric_query {
    id = "recorded"
    metric {
      namespace   = local.ns
      metric_name = "vsp_protected_actions_total"
      dimensions  = { audit = "recorded_before_ack" }
      stat        = "Sum"
      period      = 60
    }
  }

  tags = merge(var.tags, { "vsp:severity" = "critical" })
}

# Edge rate limit on the tool-caller paths (modules/ingress): counted, never enforced there, because
# safety and human-route calls share those paths with every other Talkdesk call (SAFE-02, SAFE-03).
# CountedRequests above zero means a source exceeded the limit where it is only observed.
resource "aws_cloudwatch_metric_alarm" "waf_tool_path_rate" {
  count = var.waf_web_acl_name == null || var.waf_rate_observe_metric_name == null ? 0 : 1

  alarm_name          = "${var.name_prefix}-waf-tool-path-rate-observed"
  alarm_description   = "[MEDIUM] A source exceeded the edge rate limit on the tool-caller paths, where it is counted and never enforced so that safety and human-route calls are not blocked. Runbook RB-DEPENDENCY-OUTAGE. Review the WAF logs for that source; do not switch this rule to block."
  namespace           = "AWS/WAFV2"
  metric_name         = "CountedRequests"
  dimensions          = { WebACL = var.waf_web_acl_name, Rule = var.waf_rate_observe_metric_name, Region = var.region }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  tags = merge(var.tags, { "vsp:severity" = "medium" })
}

resource "aws_cloudwatch_metric_alarm" "healthy_targets" {
  alarm_name          = "${var.name_prefix}-gateway-no-healthy-targets"
  alarm_description   = "[CRITICAL] No healthy gateway targets. Protected tools are unavailable; Studio's independent human route must carry callers. Runbook RB-DEPENDENCY-OUTAGE."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { TargetGroup = var.target_group_arn_suffix, LoadBalancer = var.alb_arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  tags = merge(var.tags, { "vsp:severity" = "critical" })
}
