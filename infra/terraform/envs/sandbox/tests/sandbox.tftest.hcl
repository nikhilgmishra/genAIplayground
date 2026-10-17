# [SPEC-15.terraform] Environment wiring plans offline with mock providers.
# Every value is SYNTHETIC (fictional accounts, placeholder retention/budget);
# the real values are UNKNOWN until their owners supply them.

mock_provider "aws" {}

mock_provider "aws" {
  alias = "audit"
}

override_resource {
  target          = module.stack.module.iam_ci[0].aws_iam_openid_connect_provider.github
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
  }
}

variables {
  workload_account_id              = "111111111111"
  audit_account_id                 = "222222222222"
  audit_deploy_role_arn            = "arn:aws:iam::222222222222:role/vsp-audit-deployer"
  region                           = "us-east-1"
  audit_region                     = "us-east-1"
  availability_zones               = ["us-east-1a", "us-east-1b", "us-east-1c"]
  vpc_cidr                         = "10.40.0.0/16"
  nat_gateway_per_az               = false
  github_repository                = "example-owner/example-repo"
  key_admin_role_arns              = ["arn:aws:iam::111111111111:role/vsp-bootstrap-admin"]
  audit_key_admin_role_arns        = ["arn:aws:iam::222222222222:role/vsp-audit-admin"]
  certificate_arn                  = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  image_digest                     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  ci_state                         = { bucket_arn = "arn:aws:s3:::vsp-tfstate-111111111111", key_prefix = "envs/sandbox/" }
  aurora_engine_version            = "16.6"
  aurora_instance_class            = "db.t4g.medium"
  aurora_backup_retention_days     = 1
  audit_object_lock_mode           = "GOVERNANCE"
  audit_object_lock_retention_days = 1
  monthly_budget_usd               = 1
  service_sizing = {
    gateway = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 2 }
    worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 2 }
  }
  retention_days = {
    application_logs = 1
    flow_logs        = 1
    waf_logs         = 1
    alb_access_logs  = 1
    database_logs    = 1
    workflow_logs    = 1
    metrics_logs     = 1
  }
}

run "sandbox_plans" {
  command = plan

  assert {
    condition     = module.stack.mutations_enabled == true
    error_message = "sandbox is a primary (write) stack"
  }

  assert {
    condition     = module.stack.ci_roles != null
    error_message = "sandbox manages its CI identity"
  }
}

run "rejects_missing_budget" {
  command = plan

  variables {
    monthly_budget_usd = null
  }

  expect_failures = [var.monthly_budget_usd]
}

run "rejects_missing_object_lock_mode" {
  command = plan

  variables {
    audit_object_lock_mode = null
  }

  expect_failures = [var.audit_object_lock_mode]
}
