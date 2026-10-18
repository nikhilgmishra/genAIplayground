output "ingress_dns_name" {
  description = "ALB DNS name."
  value       = module.stack.ingress_dns_name
}

output "ci_roles" {
  description = "CI role ARNs for the GitHub environment variables."
  value       = module.stack.ci_roles
}

output "audit_bucket_name" {
  description = "Audit evidence bucket (audit account)."
  value       = module.stack.audit_bucket_name
}

output "dashboards" {
  description = "Dashboards."
  value       = module.stack.dashboards
}

output "mutations_enabled" {
  description = "Write fence state."
  value       = module.stack.mutations_enabled
}

output "dr_inputs" {
  description = "Inputs for the production-dr stack (replica table, replica CMK, global cluster, audit store)."
  value       = module.stack.dr_inputs
}
