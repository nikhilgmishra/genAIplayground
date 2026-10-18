output "bucket_name" {
  description = "Audit evidence bucket (audit account)."
  value       = aws_s3_bucket.audit.id
}

output "bucket_arn" {
  description = "Audit evidence bucket ARN."
  value       = local.bucket_arn
}

output "evidence_prefix" {
  description = "Key prefix the writer role may put to."
  value       = var.evidence_prefix
}

output "writer_role_arn" {
  description = "Write-only role the workload shippers assume (sts:AssumeRole from the workload task roles)."
  value       = local.writer_role_arn
}

output "auditor_role_arn" {
  description = "Read-only auditor role ARN, or null when auditor principals are not yet provided (BLOCKED on the identity owner)."
  value       = local.create_auditor ? local.auditor_role_arn : null
}

output "verifier_role_arn" {
  description = "Read-only evidence verifier role ARN for the platform audit.verify loop, or null when verifier principals are not provided (OPS-AUD-02)."
  value       = local.create_verifier ? local.verifier_role_arn : null
}

output "kms_key_arn" {
  description = "Audit-account CMK."
  value       = aws_kms_key.audit.arn
}

output "object_lock" {
  description = "Object Lock default retention as configured by counsel/security."
  value       = { mode = var.object_lock_mode, days = var.object_lock_retention_days }
}

output "bucket_policy" {
  description = "Rendered bucket policy (for review)."
  value       = local.bucket_policy
}
