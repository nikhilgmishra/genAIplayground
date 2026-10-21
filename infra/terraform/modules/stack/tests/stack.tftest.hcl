# [SPEC-3.stack] [SPEC-12.fence] [OPS-05] Composition of all modules for a primary
# environment, a production primary with a DR replica, and the write-fenced DR stack.
# Offline: mock providers, plan only. Every value below is SYNTHETIC test input
# (fictional account ids, placeholder sizing, placeholder retention); none is a decision.

mock_provider "aws" {}

mock_provider "aws" {
  alias = "audit"
}

override_resource {
  target          = module.iam_ci[0].aws_iam_openid_connect_provider.github
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
  }
}

variables {
  environment         = "sandbox"
  name_prefix         = "vsp-sandbox"
  workload_account_id = "111111111111"
  audit_account_id    = "222222222222"
  region              = "us-east-1"
  audit_region        = "us-east-1"
  availability_zones  = ["us-east-1a", "us-east-1b", "us-east-1c"]
  vpc_cidr            = "10.40.0.0/16"
  nat_gateway_per_az  = false
  key_admin_role_arns = ["arn:aws:iam::111111111111:role/vsp-bootstrap-admin"]
  github_repository   = "example-owner/example-repo"
  certificate_arn     = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  mutations_enabled   = true
  asl_dir             = "../../../stepfunctions"

  ci = {
    manage               = true
    create_oidc_provider = true
    github_environment   = "sandbox"
    allowed_regions      = ["us-east-1"]
    state_bucket_arn     = "arn:aws:s3:::vsp-tfstate-111111111111"
    state_key_prefix     = "envs/sandbox/"
  }

  image = {
    digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }

  service_sizing = {
    gateway = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 2 }
    worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 2 }
  }

  aurora = {
    engine_version        = "16.6"
    instance_class        = "db.t4g.medium"
    backup_retention_days = 1
  }

  sessions = {
    create = true
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

  audit = {
    managed_here               = true
    object_lock_mode           = "GOVERNANCE"
    object_lock_retention_days = 1
    key_admin_role_arns        = ["arn:aws:iam::222222222222:role/vsp-audit-admin"]
  }

  budget = {
    create            = true
    monthly_limit_usd = 1
  }
}

run "primary_sandbox_composition" {
  command = plan

  providers = {
    aws       = aws
    aws.audit = aws.audit
  }

  assert {
    condition     = module.ecs.write_fence_active == false
    error_message = "primary region accepts mutations"
  }

  assert {
    condition     = length(module.dynamodb_sessions) == 1 && length(module.audit) == 1 && length(module.budgets) == 1 && length(module.iam_ci) == 1
    error_message = "primary creates the session table, audit store, budget and CI identity"
  }

  assert {
    condition     = contains(local.worker_statements[*].Sid, "AssumeWriteOnlyAuditShipperRole") && !contains(local.gateway_statements[*].Sid, "AssumeWriteOnlyAuditShipperRole")
    error_message = "[SPEC-14.iam] only the worker (audit shipper) can assume the audit writer role"
  }

  assert {
    condition     = !contains(flatten(local.gateway_statements[*].Action), "sqs:ReceiveMessage")
    error_message = "the gateway does not consume queues"
  }

  assert {
    condition     = local.secret_refs["gateway"] != null && !contains(keys(local.secret_refs["gateway"]), "notifications")
    error_message = "secret access is per service (notifications only for the worker)"
  }

  assert {
    condition     = contains(keys(local.secret_refs["gateway"]), "request-hash-pepper") && !contains(keys(local.secret_refs["worker"]), "request-hash-pepper") && local.secret_defs["request-hash-pepper"].owner == "security_admin"
    error_message = "[DATA-01][DP-02] the request-hash pepper container is readable by the gateway only (value loaded by its owner, never by Terraform)"
  }

  assert {
    condition     = strcontains(module.kms.key_policies["sessions"], "vsp-sandbox-gateway-task") && !strcontains(module.kms.key_policies["sessions"], "worker-task")
    error_message = "session key usable only by the gateway task role"
  }

  assert {
    condition     = length(module.step_functions.definition_files) == length(fileset("../../../stepfunctions", "*.asl.json"))
    error_message = "[SPEC-9.workflows] every generated ASL definition renders with the provided queue placeholders"
  }

  assert {
    condition     = contains(local.key_admins, "arn:aws:iam::111111111111:role/vsp-sandbox-gha-apply")
    error_message = "the CI apply role administers keys (lockout safety check)"
  }
}

run "production_primary_with_dr_replica" {
  command = plan

  providers = {
    aws       = aws
    aws.audit = aws.audit
  }

  variables {
    environment        = "production"
    name_prefix        = "vsp-production"
    nat_gateway_per_az = true
    service_sizing = {
      gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
      worker  = { cpu = 512, memory = 1024, min_capacity = 2, max_capacity = 4 }
    }
    aurora = {
      engine_version        = "16.6"
      instance_class        = "db.r7g.large"
      backup_retention_days = 1
      cluster_role          = "global_primary"
    }
    sessions = {
      create         = true
      replica_region = "us-west-2"
      dr_name_prefix = "vsp-prod-dr"
    }
    audit = {
      managed_here                = true
      object_lock_mode            = "GOVERNANCE"
      object_lock_retention_days  = 1
      key_admin_role_arns         = ["arn:aws:iam::222222222222:role/vsp-audit-admin"]
      additional_writer_role_arns = ["arn:aws:iam::111111111111:role/vsp-prod-dr-worker-task"]
    }
    ci = {
      manage               = true
      create_oidc_provider = true
      github_environment   = "production"
      allowed_regions      = ["us-east-1", "us-west-2"]
      state_bucket_arn     = "arn:aws:s3:::vsp-tfstate-111111111111"
      state_key_prefix     = "envs/production/"
    }
  }

  assert {
    condition     = length(aws_kms_key.session_replica) == 1 && aws_kms_key.session_replica[0].region == "us-west-2"
    error_message = "[SPEC-12.recovery] the DR replica gets its own regional CMK"
  }

  # Wildcard-aware (same check as modules/kms): kms:Create* would match kms:CreateGrant.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_kms_key.session_replica[0].policy).Statement : try(s.Condition.Bool["kms:GrantIsForAWSResource"], null) == "true"
      if s.Effect == "Allow" && (try(s.Principal.AWS, null) != null || try(s.Principal, null) == "*") && (
        try(s.NotAction, null) == null
        ? anytrue([for a in flatten([try(s.Action, [])]) : can(regex("^(?i)${replace(replace(a, "*", ".*"), "?", ".")}$", "kms:CreateGrant"))])
        : !anytrue([for a in flatten([s.NotAction]) : can(regex("^(?i)${replace(replace(a, "*", ".*"), "?", ".")}$", "kms:CreateGrant"))])
      )
    ])
    error_message = "[SPEC-14.kms] no Allow for an IAM principal on the DR replica key (key admins include gha-apply) may match kms:CreateGrant without Bool kms:GrantIsForAWSResource = true"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_kms_key.session_replica[0].policy).Statement : contains(s.Action, "kms:CreateGrant") && s.Condition.Bool["kms:GrantIsForAWSResource"] == "true" && contains(s.Principal.AWS, "arn:aws:iam::111111111111:role/vsp-production-gha-apply")
      if s.Sid == "AttachKeyToAwsResourcesOnly"
    ])
    error_message = "key administrators (including the CI apply role) keep grants for AWS resources (the DynamoDB replica)"
  }

  assert {
    condition     = length(module.dynamodb_sessions[0].table_name) > 0
    error_message = "session table created in the primary"
  }

  assert {
    condition     = contains(module.audit[0].object_lock.mode == "GOVERNANCE" ? ["ok"] : [], "ok")
    error_message = "audit store configured with the supplied Object Lock values"
  }
}

run "dr_stack_is_write_fenced" {
  command = plan

  providers = {
    aws       = aws
    aws.audit = aws
  }

  variables {
    environment        = "production"
    deployment_role    = "dr"
    name_prefix        = "vsp-prod-dr"
    region             = "us-west-2"
    mutations_enabled  = false
    availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c"]
    certificate_arn    = "arn:aws:acm:us-west-2:111111111111:certificate/00000000-0000-0000-0000-000000000000"
    service_sizing = {
      gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
      worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 4 }
    }
    aurora = {
      engine_version            = "16.6"
      instance_class            = "db.r7g.large"
      backup_retention_days     = 1
      cluster_role              = "global_secondary"
      global_cluster_identifier = "vsp-production-ledger-global"
    }
    sessions = {
      create              = false
      existing_table_name = "vsp-production-sessions"
      replica_kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-0000000000dd"
    }
    audit = {
      managed_here             = false
      existing_bucket_name     = "vsp-production-audit-222222222222"
      existing_writer_role_arn = "arn:aws:iam::222222222222:role/vsp-production-audit-writer"
    }
    budget = {
      create = false
    }
    ci = {
      manage               = true
      create_oidc_provider = false
      oidc_provider_arn    = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
      github_environment   = "production-dr"
      allowed_regions      = ["us-west-2", "us-east-1"]
      state_bucket_arn     = "arn:aws:s3:::vsp-tfstate-111111111111"
      state_key_prefix     = "envs/production-dr/"
    }
  }

  assert {
    condition     = module.ecs.write_fence_active == true
    error_message = "[SPEC-12.fence] DR task roles carry the explicit IAM write fence"
  }

  assert {
    condition     = length(module.dynamodb_sessions) == 0 && length(module.audit) == 0 && length(module.budgets) == 0
    error_message = "DR uses the primary's replica table and audit store; the account budget lives in the primary stack"
  }

  assert {
    condition     = local.sessions_table_arn == "arn:aws:dynamodb:us-west-2:111111111111:table/vsp-production-sessions"
    error_message = "DR addresses the regional replica of the primary table"
  }

  assert {
    condition     = contains([for e in module.ecs.container_definitions["gateway"][0].environment : "${e.name}=${e.value}"], "VSP_MUTATIONS_ENABLED=false")
    error_message = "DR containers are told mutations are disabled"
  }
}

run "rejects_dr_mutations_without_failover_decision" {
  command = plan

  providers = {
    aws       = aws
    aws.audit = aws
  }

  variables {
    environment        = "production"
    deployment_role    = "dr"
    name_prefix        = "vsp-prod-dr"
    region             = "us-west-2"
    mutations_enabled  = true
    availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c"]
    service_sizing = {
      gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
      worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 4 }
    }
    aurora = {
      engine_version            = "16.6"
      instance_class            = "db.r7g.large"
      backup_retention_days     = 1
      cluster_role              = "global_secondary"
      global_cluster_identifier = "vsp-production-ledger-global"
    }
    sessions = {
      create              = false
      existing_table_name = "vsp-production-sessions"
      replica_kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-0000000000dd"
    }
    audit = {
      managed_here             = false
      existing_bucket_name     = "vsp-production-audit-222222222222"
      existing_writer_role_arn = "arn:aws:iam::222222222222:role/vsp-production-audit-writer"
    }
  }

  expect_failures = [terraform_data.stack_guards]
}

run "rejects_dr_stack_with_standalone_ledger" {
  command = plan

  providers = {
    aws       = aws
    aws.audit = aws
  }

  variables {
    environment       = "production"
    deployment_role   = "dr"
    name_prefix       = "vsp-prod-dr"
    mutations_enabled = false
    service_sizing = {
      gateway = { cpu = 1024, memory = 2048, min_capacity = 3, max_capacity = 6 }
      worker  = { cpu = 512, memory = 1024, min_capacity = 1, max_capacity = 4 }
    }
    audit = {
      managed_here             = false
      existing_bucket_name     = "vsp-production-audit-222222222222"
      existing_writer_role_arn = "arn:aws:iam::222222222222:role/vsp-production-audit-writer"
    }
  }

  expect_failures = [terraform_data.stack_guards]
}
