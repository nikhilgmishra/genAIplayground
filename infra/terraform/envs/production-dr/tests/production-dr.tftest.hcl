# [SPEC-12.fence] [SPEC-3.dr] The DR stack plans offline, is write-fenced by default and
# refuses mutations without a reviewed failover reference. SYNTHETIC values only.

mock_provider "aws" {}

variables {
  workload_account_id          = "111111111111"
  audit_account_id             = "222222222222"
  region                       = "us-west-2"
  primary_region               = "us-east-1"
  audit_region                 = "us-east-1"
  availability_zones           = ["us-west-2a", "us-west-2b", "us-west-2c"]
  vpc_cidr                     = "10.43.0.0/16"
  github_repository            = "example-owner/example-repo"
  key_admin_role_arns          = ["arn:aws:iam::111111111111:role/vsp-bootstrap-admin"]
  certificate_arn              = "arn:aws:acm:us-west-2:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  image_digest                 = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  ci_state                     = { bucket_arn = "arn:aws:s3:::vsp-tfstate-111111111111", key_prefix = "envs/production-dr/" }
  aurora_engine_version        = "16.6"
  aurora_instance_class        = "db.r7g.large"
  aurora_backup_retention_days = 1
  sessions_replica_kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-0000000000dd"
  audit_bucket_name            = "vsp-production-audit-222222222222"
  audit_writer_role_arn        = "arn:aws:iam::222222222222:role/vsp-production-audit-writer"
  service_sizing = {
    gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
    worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 4 }
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

run "fenced_by_default" {
  command = plan

  assert {
    condition     = module.stack.mutations_enabled == false
    error_message = "[SPEC-12.fence] production-dr is write-fenced by default"
  }
}

run "mutations_need_failover_decision" {
  command = plan

  variables {
    mutations_enabled = true
  }

  expect_failures = [var.mutations_enabled]
}

run "reviewed_failover_can_open_writes" {
  command = plan

  variables {
    mutations_enabled   = true
    failover_change_ref = "CHG-SYNTHETIC-0001"
  }

  assert {
    condition     = module.stack.mutations_enabled == true
    error_message = "a reviewed failover reference lifts the fence"
  }
}
