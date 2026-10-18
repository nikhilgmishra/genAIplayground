output "ingress_dns_name" {
  description = "DR ALB DNS name (endpoint switch-over is a Talkdesk/DNS change owned by operations: UNKNOWN mechanism)."
  value       = module.stack.ingress_dns_name
}

output "ci_roles" {
  description = "CI role ARNs for the production-dr GitHub environments."
  value       = module.stack.ci_roles
}

output "mutations_enabled" {
  description = "false = write fence active."
  value       = module.stack.mutations_enabled
}

output "dashboards" {
  description = "Dashboards."
  value       = module.stack.dashboards
}
