# [SPEC-14.secrets] [AUTH-06] Secret containers only (no values), CMK, explicit
# deny for non-reader principals, rotation hooks optional. Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix     = "vsp-test"
  kms_key_arn     = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000008"
  admin_role_arns = ["arn:aws:iam::111111111111:role/vsp-test-deployer"]
  secrets = {
    salesforce-integration = {
      description      = "Salesforce integration OAuth client (placeholder container)"
      owner            = "salesforce_admin"
      reader_role_arns = ["arn:aws:iam::111111111111:role/vsp-test-worker-task"]
    }
    scheduling-api = {
      description         = "Scheduling API client (placeholder container)"
      owner               = "business_system_owner"
      reader_role_arns    = ["arn:aws:iam::111111111111:role/vsp-test-gateway-task"]
      rotation_lambda_arn = "arn:aws:lambda:us-east-1:111111111111:function:vsp-test-rotate-scheduling"
      rotation_days       = 30
    }
  }
}

run "containers_without_values" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret.this) == 2
    error_message = "secret containers are created"
  }

  assert {
    condition     = alltrue([for s in aws_secretsmanager_secret.this : s.kms_key_id == var.kms_key_arn])
    error_message = "[SPEC-6.encryption] secrets use the CMK"
  }

  assert {
    condition     = alltrue([for p in aws_secretsmanager_secret_policy.this : p.block_public_policy])
    error_message = "public secret policies are blocked"
  }

  assert {
    condition = one([for st in jsondecode(aws_secretsmanager_secret_policy.this["salesforce-integration"].policy).Statement :
    st.Condition.ArnNotEquals["aws:PrincipalArn"] if st.Sid == "DenyValueReadExceptNamedReaders"]) == ["arn:aws:iam::111111111111:role/vsp-test-worker-task"]
    error_message = "[SPEC-14.iam] only the named reader can read the value"
  }

  assert {
    condition     = length(aws_secretsmanager_secret_rotation.this) == 1 && output.rotation_status["salesforce-integration"] == "NOT_CONFIGURED"
    error_message = "rotation hooks are explicit; missing hooks are reported, not hidden"
  }
}

run "rejects_secret_without_reader" {
  command = plan

  variables {
    secrets = {
      orphan = {
        description      = "no reader"
        owner            = "nobody"
        reader_role_arns = []
      }
    }
  }

  expect_failures = [var.secrets]
}
