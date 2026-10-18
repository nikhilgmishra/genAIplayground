# SANDBOX environment root (synthetic data only; no PHI). Plan-only from this
# repository: applying it creates billable resources and requires a scoped
# BILLABLE_TEST_EXECUTION approval (OPS-05) plus the GitHub environment reviewers.

locals {
  environment = "sandbox"
  name_prefix = "vsp-sandbox"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.workload_account_id]

  default_tags {
    tags = {
      "vsp:environment" = local.environment
      "vsp:managed-by"  = "terraform"
      "vsp:repository"  = var.github_repository
      "vsp:data-scope"  = "synthetic-only"
    }
  }
}

# Separate AUDIT ACCOUNT provider. allowed_account_ids makes Terraform refuse to act
# if the assumed role resolves to any other account.
provider "aws" {
  alias               = "audit"
  region              = var.audit_region
  allowed_account_ids = [var.audit_account_id]

  assume_role {
    role_arn     = var.audit_deploy_role_arn
    session_name = "vsp-${local.environment}-terraform"
  }

  default_tags {
    tags = {
      "vsp:environment" = local.environment
      "vsp:managed-by"  = "terraform"
      "vsp:repository"  = var.github_repository
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  providers = {
    aws       = aws
    aws.audit = aws.audit
  }

  environment         = local.environment
  deployment_role     = "primary"
  name_prefix         = local.name_prefix
  workload_account_id = var.workload_account_id
  audit_account_id    = var.audit_account_id
  region              = var.region
  audit_region        = var.audit_region
  availability_zones  = var.availability_zones
  vpc_cidr            = var.vpc_cidr
  nat_gateway_per_az  = var.nat_gateway_per_az
  key_admin_role_arns = var.key_admin_role_arns
  github_repository   = var.github_repository
  certificate_arn     = var.certificate_arn
  ingress             = var.ingress
  mutations_enabled   = true
  asl_dir             = "${path.root}/../../../stepfunctions"

  ci = {
    manage               = true
    create_oidc_provider = true
    github_environment   = local.environment
    allowed_regions      = [var.region]
    state_bucket_arn     = var.ci_state.bucket_arn
    state_key_prefix     = var.ci_state.key_prefix
    state_kms_key_arn    = var.ci_state.kms_key_arn
  }

  image = {
    digest = var.image_digest
  }

  service_sizing = var.service_sizing

  aurora = {
    engine_version        = var.aurora_engine_version
    instance_class        = var.aurora_instance_class
    backup_retention_days = var.aurora_backup_retention_days
    cluster_role          = "standalone"
  }

  sessions = {
    create = true
  }

  retention_days = var.retention_days

  audit = {
    managed_here               = true
    object_lock_mode           = var.audit_object_lock_mode
    object_lock_retention_days = var.audit_object_lock_retention_days
    auditor_principal_arns     = var.audit_auditor_principal_arns
    key_admin_role_arns        = var.audit_key_admin_role_arns
  }

  budget = {
    create            = true
    monthly_limit_usd = var.monthly_budget_usd
  }
}
