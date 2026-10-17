# PRODUCTION non-secret configuration. No value here is an approval.
# Account ids, certificate ARN, image digest, role ARNs and state location are
# supplied by CI as TF_VAR_* from the GitHub "production" environment variables.
#
# Values marked PROPOSED / PLACEHOLDER are engineering placeholders, not decisions.
# Values marked UNKNOWN are deliberately absent: `terraform plan` fails until the
# named owner supplies them (fail closed).

region             = "us-east-1" # PROPOSED: confirm against the BAA eligible-service list (owner: platform owner)
dr_region          = "us-west-2" # PROPOSED secondary US region (owner: platform owner + SRE)
audit_region       = "us-east-1" # PROPOSED
availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
vpc_cidr           = "10.42.0.0/16" # PROPOSED: confirm non-overlap (owner: network team)
nat_gateway_per_az = true

github_repository = "nikhilgmishra/genAIplayground"

# PLACEHOLDER sizing (not capacity evidence; SRE sizes from load tests, spec section 12).
service_sizing = {
  gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
  worker  = { cpu = 512, memory = 1024, min_capacity = 2, max_capacity = 4 }
}

aurora_engine_version = "16.6"         # verify availability: aws rds describe-db-engine-versions --engine aurora-postgresql
aurora_instance_class = "db.r7g.large" # PLACEHOLDER

# UNKNOWN (owner: security operations + privacy counsel; retention matrix, spec section 6):
# aurora_backup_retention_days = <set by owner>
# retention_days = {
#   application_logs = <set by owner>
#   flow_logs        = <set by owner>
#   waf_logs         = <set by owner>
#   alb_access_logs  = <set by owner>
#   database_logs    = <set by owner>
#   workflow_logs    = <set by owner>
#   metrics_logs     = <set by owner>
# }

# UNKNOWN (owner: privacy counsel + security leadership):
# audit_object_lock_mode           = "GOVERNANCE" | "COMPLIANCE"
# audit_object_lock_retention_days = <set by owner>

# UNKNOWN (owner: finance + platform owner). Budgets are alerts, not caps.
# monthly_budget_usd = <set by owner>
