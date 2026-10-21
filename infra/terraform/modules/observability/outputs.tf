output "alarm_topic_arn" {
  description = "KMS-encrypted SNS topic for alarms and budget notifications."
  value       = aws_sns_topic.alarms.arn
}

output "dashboard_names" {
  description = "CloudWatch dashboards."
  value       = [for d in aws_cloudwatch_dashboard.this : d.dashboard_name]
}

output "alarm_names" {
  description = "Application and platform alarm names."
  value       = concat([for a in aws_cloudwatch_metric_alarm.app : a.alarm_name], [aws_cloudwatch_metric_alarm.audit_not_recorded_ratio.alarm_name, aws_cloudwatch_metric_alarm.http_5xx_rate.alarm_name, aws_cloudwatch_metric_alarm.healthy_targets.alarm_name], [for a in aws_cloudwatch_metric_alarm.waf_tool_path_rate : a.alarm_name])
}

output "metrics_log_group_name" {
  description = "Log group for embedded-metric-format ingestion."
  value       = aws_cloudwatch_log_group.metrics.name
}

output "catalogue_metric_names" {
  description = "Catalogue metric names referenced by dashboards and alarms (checked against platform/src/observability/metrics.ts by scripts/ci/check-metric-names.mjs)."
  value = sort(distinct(concat(
    flatten([for _, ws in local.dashboards : [for w in ws : [for r in w.rows : r.m[1] if r.m[0] == local.ns]]]),
    [for a in values(local.alarms) : a.metric],
    local.math_alarm_metrics,
  )))
}
