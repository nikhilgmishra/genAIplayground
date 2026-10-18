output "key_arns" {
  description = "Key ARNs by purpose."
  value       = { for k, v in aws_kms_key.this : k => v.arn }
}

output "key_ids" {
  description = "Key ids by purpose."
  value       = { for k, v in aws_kms_key.this : k => v.key_id }
}

output "alias_names" {
  description = "Alias names by purpose."
  value       = { for k, v in aws_kms_alias.this : k => v.name }
}

output "key_policies" {
  description = "Rendered key policies (no secrets) for review and policy tests."
  value       = local.key_policies
}
