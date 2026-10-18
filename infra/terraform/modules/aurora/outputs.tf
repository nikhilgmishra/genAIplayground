output "cluster_arn" {
  description = "Cluster ARN."
  value       = aws_rds_cluster.this.arn
}

output "cluster_identifier" {
  description = "Cluster identifier."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "cluster_resource_id" {
  description = "Cluster resource id (used in rds-db:connect IAM authentication ARNs)."
  value       = aws_rds_cluster.this.cluster_resource_id
}

output "writer_endpoint" {
  description = "Writer endpoint."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "security_group_id" {
  description = "Database security group."
  value       = aws_security_group.db.id
}

output "master_user_secret_arn" {
  description = "RDS-managed master secret ARN (break-glass only; applications use IAM authentication)."
  value       = try(aws_rds_cluster.this.master_user_secret[0].secret_arn, null)
}

output "global_cluster_identifier" {
  description = "Global cluster identifier when this stack created it."
  value       = try(aws_rds_global_cluster.this[0].id, null)
}

output "cluster_parameters" {
  description = "Cluster parameters enforced by the parameter group."
  value       = local.cluster_parameters
}
