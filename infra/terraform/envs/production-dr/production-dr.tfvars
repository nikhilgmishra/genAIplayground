# PRODUCTION-DR non-secret configuration (secondary US region, write-fenced).
# Account ids, certificate ARN, image digest, role ARNs, state location and the
# dr_inputs values from envs/production are supplied by CI as TF_VAR_* from the
# GitHub "production-dr" environment variables.

region             = "us-west-2" # PROPOSED secondary US region (owner: platform owner + SRE)
primary_region     = "us-east-1"
audit_region       = "us-east-1"
availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c"]
vpc_cidr           = "10.43.0.0/16" # PROPOSED

github_repository = "nikhilgmishra/genAIplayground"

# Write fence ON. Changing this requires failover_change_ref from a reviewed failover.
mutations_enabled = false

# PLACEHOLDER warm-standby sizing (recovery objective is a proposal pending drills).
service_sizing = {
  gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
  worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 4 }
}

aurora_engine_version = "16.6"         # must equal the global cluster version
aurora_instance_class = "db.r7g.large" # PLACEHOLDER

# UNKNOWN (owner: security operations + privacy counsel):
# aurora_backup_retention_days = <set by owner>
# retention_days = { application_logs = ..., flow_logs = ..., waf_logs = ..., alb_access_logs = ..., database_logs = ..., workflow_logs = ..., metrics_logs = ... }
