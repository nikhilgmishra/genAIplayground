# PRODUCTION-DR environment root: the tested secondary US region (spec sections 3
# and 12). One write region: this stack is WRITE-FENCED by default
# (mutations_enabled = false -> VSP_MUTATIONS_ENABLED=false in every container AND an
# explicit IAM Deny on session-table, queue and state-machine writes). The Aurora
# ledger is a read-only Global Database secondary with no write forwarding.
# Safe telephone routing stays in Talkdesk Studio and is independent of this stack.
#
# Apply order (performed by CI after approval, never by the coding agent):
#   1. envs/production (creates the global cluster, the DR session replica + its CMK,
#      and the audit store that also trusts this stack's worker role)
#   2. envs/production-dr with the dr_inputs outputs of step 1.

locals {
  environment = "production"
  name_prefix = "vsp-prod-dr"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.workload_account_id]

  default_tags {
    tags = {
      "vsp:environment"     = "production-dr"
      "vsp:managed-by"      = "terraform"
      "vsp:repository"      = var.github_repository
      "vsp:deployment-role" = "dr"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  # No audit resources are managed from the DR stack; the audit alias is unused.
  providers = {
    aws       = aws
    aws.audit = aws
  }

  environment         = local.environment
  deployment_role     = "dr"
  name_prefix         = local.name_prefix
  workload_account_id = var.workload_account_id
  audit_account_id    = var.audit_account_id
  region              = var.region
  audit_region        = var.audit_region
  availability_zones  = var.availability_zones
  vpc_cidr            = var.vpc_cidr
  nat_gateway_per_az  = true
  key_admin_role_arns = var.key_admin_role_arns
  github_repository   = var.github_repository
  certificate_arn     = var.certificate_arn
  ingress             = var.ingress
  mutations_enabled   = var.mutations_enabled
  failover_change_ref = var.failover_change_ref
  asl_dir             = "${path.root}/../../../stepfunctions"

  ci = {
    manage               = true
    create_oidc_provider = false
    oidc_provider_arn    = "arn:aws:iam::${var.workload_account_id}:oidc-provider/token.actions.githubusercontent.com"
    github_environment   = "production-dr"
    allowed_regions      = [var.region, var.primary_region]
    state_bucket_arn     = var.ci_state.bucket_arn
    state_key_prefix     = var.ci_state.key_prefix
    state_kms_key_arn    = var.ci_state.kms_key_arn
  }

  image = {
    digest = var.image_digest
  }

  service_sizing = var.service_sizing

  aurora = {
    engine_version            = var.aurora_engine_version
    instance_class            = var.aurora_instance_class
    backup_retention_days     = var.aurora_backup_retention_days
    cluster_role              = "global_secondary"
    global_cluster_identifier = var.global_cluster_identifier
  }

  sessions = {
    create              = false
    existing_table_name = "vsp-production-sessions"
    replica_kms_key_arn = var.sessions_replica_kms_key_arn
  }

  retention_days = var.retention_days

  audit = {
    managed_here             = false
    existing_bucket_name     = var.audit_bucket_name
    existing_writer_role_arn = var.audit_writer_role_arn
  }

  # The account budget lives in envs/production (same account).
  budget = {
    create = false
  }
}
