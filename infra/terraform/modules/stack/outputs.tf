output "ingress_dns_name" {
  description = "ALB DNS name for the approved hostname's alias record (DNS is out of scope: UNKNOWN owner)."
  value       = module.ingress.alb_dns_name
}

output "nat_egress_ips" {
  description = "Egress IPs (supplemental vendor allowlists only)."
  value       = module.network.nat_public_ips
}

output "ecs_cluster_name" {
  description = "ECS cluster."
  value       = module.ecs.cluster_name
}

output "task_role_arns" {
  description = "Task roles by service."
  value       = module.ecs.task_role_arns
}

output "sessions_table_name" {
  description = "Session table (or replica) name."
  value       = local.sessions_table_name
}

output "queue_urls" {
  description = "Queue URLs by key."
  value       = module.sqs.queue_urls
}

output "state_machine_arns" {
  description = "State machines by workflow."
  value       = module.step_functions.state_machine_alias_arns
}

output "ledger_writer_endpoint" {
  description = "Aurora writer endpoint (read-only secondary in DR)."
  value       = module.aurora.writer_endpoint
}

output "audit_bucket_name" {
  description = "Audit evidence bucket in the audit account."
  value       = local.audit_bucket_name
}

output "audit_writer_role_arn" {
  description = "Write-only audit role assumed by the worker."
  value       = local.audit_writer_role_arn
}

output "alarm_topic_arn" {
  description = "Alarm topic (subscriptions BLOCKED on the on-call roster)."
  value       = module.observability.alarm_topic_arn
}

output "dashboards" {
  description = "Dashboard names."
  value       = module.observability.dashboard_names
}

output "ci_roles" {
  description = "CI plan/apply role ARNs (null when CI identity is managed elsewhere)."
  value       = var.ci.manage ? { plan = module.iam_ci[0].plan_role_arn, apply = module.iam_ci[0].apply_role_arn } : null
}

output "mutations_enabled" {
  description = "false = the regional write fence is active."
  value       = var.mutations_enabled
}

output "dr_inputs" {
  description = "Values the production-dr stack consumes from the primary stack."
  value = {
    sessions_table_name       = local.sessions_table_name
    sessions_replica_kms_arn  = try(aws_kms_key.session_replica[0].arn, null)
    global_cluster_identifier = module.aurora.global_cluster_identifier
    audit_bucket_name         = local.audit_bucket_name
    audit_writer_role_arn     = local.audit_writer_role_arn
  }
}
