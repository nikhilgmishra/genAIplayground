output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_names" {
  description = "ECS service names by key."
  value       = { for k, s in aws_ecs_service.service : k => s.name }
}

output "task_role_arns" {
  description = "Task role ARNs by service."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}

output "execution_role_arn" {
  description = "Task execution role ARN."
  value       = aws_iam_role.execution.arn
}

output "security_group_ids" {
  description = "Service security groups by key (database and other server modules add their rules)."
  value       = { for k, g in aws_security_group.service : k => g.id }
}

output "log_group_names" {
  description = "Application log groups by service."
  value       = { for k, g in aws_cloudwatch_log_group.service : k => g.name }
}

output "repository_url" {
  description = "Image repository URL."
  value       = local.repo_url
}

output "container_definitions" {
  description = "Rendered container definitions (for review and tests; contain no secret values)."
  value       = local.container_definitions
}

output "write_fence_active" {
  description = "true when the explicit IAM write fence is attached."
  value       = local.fenced
}
