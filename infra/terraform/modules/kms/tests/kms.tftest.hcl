# [SPEC-6.kms] [SPEC-14.kms] Customer-managed keys: rotation on, no kms:* grants,
# no wildcard principals, usage limited to named roles. Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix         = "vsp-test"
  account_id          = "111111111111"
  region              = "us-east-1"
  key_admin_role_arns = ["arn:aws:iam::111111111111:role/vsp-test-deployer"]
  keys = {
    sessions = {
      description        = "session state"
      data_class         = "TRANSIENT_CONVERSATION"
      usage_role_arns    = ["arn:aws:iam::111111111111:role/vsp-test-gateway-task"]
      via_services       = ["dynamodb"]
      service_principals = []
    }
    logs = {
      description        = "log groups"
      data_class         = "OPERATIONAL_TELEMETRY"
      usage_role_arns    = []
      via_services       = []
      service_principals = ["logs"]
    }
    ephemeral = {
      description        = "fargate ephemeral storage"
      data_class         = "TRANSIENT_CONVERSATION"
      usage_role_arns    = []
      via_services       = []
      service_principals = ["fargate_ephemeral"]
      ecs_cluster_name   = "vsp-test-cluster"
    }
  }
}

run "keys_rotate_and_policies_are_scoped" {
  command = plan

  assert {
    condition     = alltrue([for k in aws_kms_key.this : k.enable_key_rotation])
    error_message = "[SPEC-14.kms] every CMK must have automatic rotation enabled"
  }

  assert {
    condition     = alltrue([for k in aws_kms_key.this : k.deletion_window_in_days == 30])
    error_message = "deletion window defaults to 30 days"
  }

  assert {
    condition = alltrue(flatten([for _, p in local.key_policies : [
      for s in jsondecode(p).Statement : !contains(flatten([s.Action]), "kms:*")
    ]]))
    error_message = "[SPEC-14.kms] no key policy statement may grant kms:*"
  }

  assert {
    condition = alltrue(flatten([for _, p in local.key_policies : [
      for s in jsondecode(p).Statement : try(s.Principal.AWS, null) != "*" && try(s.Principal, null) != "*"
    ]]))
    error_message = "[SPEC-14.kms] no wildcard principals in key policies"
  }

  assert {
    condition = alltrue(flatten([for _, p in local.key_policies : [
      for s in jsondecode(p).Statement : !contains(flatten([s.Action]), "kms:Decrypt") if s.Sid == "KeyAdministrationWithoutCryptographicUse"
    ]]))
    error_message = "key administrators must not be able to decrypt"
  }

  assert {
    condition = one([
      for s in jsondecode(local.key_policies["sessions"]).Statement : s.Condition.ArnEquals["aws:PrincipalArn"] if s.Sid == "WorkloadUseByNamedRolesOnly"
    ]) == ["arn:aws:iam::111111111111:role/vsp-test-gateway-task"]
    error_message = "workload use is restricted to the named role ARNs"
  }

  assert {
    condition = one([
      for s in jsondecode(local.key_policies["sessions"]).Statement : s.Condition.StringEquals["kms:ViaService"] if s.Sid == "WorkloadUseByNamedRolesOnly"
    ]) == ["dynamodb.us-east-1.amazonaws.com"]
    error_message = "session key use must go through DynamoDB"
  }

  assert {
    condition     = length([for s in jsondecode(local.key_policies["logs"]).Statement : s if s.Sid == "WorkloadUseByNamedRolesOnly"]) == 0
    error_message = "a key without usage roles has no workload statement"
  }

  assert {
    condition     = aws_kms_alias.this["sessions"].name == "alias/vsp-test-sessions"
    error_message = "alias names are opaque and derived from the prefix"
  }

  assert {
    condition     = aws_kms_key.this["sessions"].tags["vsp:data-class"] == "TRANSIENT_CONVERSATION"
    error_message = "keys are tagged with their data class"
  }
}

run "rejects_unknown_service_principal" {
  command = plan

  variables {
    keys = {
      bad = {
        description        = "bad"
        data_class         = "BUSINESS_RECORD"
        usage_role_arns    = []
        via_services       = []
        service_principals = ["s3"]
      }
    }
  }

  expect_failures = [var.keys]
}

run "rejects_unknown_data_class" {
  command = plan

  variables {
    keys = {
      bad = {
        description        = "bad"
        data_class         = "EVERYTHING"
        usage_role_arns    = []
        via_services       = []
        service_principals = []
      }
    }
  }

  expect_failures = [var.keys]
}
