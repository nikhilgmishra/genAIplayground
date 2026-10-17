# [SPEC-15.ci] [SPEC-14.iam] GitHub OIDC federation: exact repo + environment
# subjects, audience sts.amazonaws.com, permissions boundary, no long-lived keys,
# no data-plane reads. Offline: mock provider, plan only.

mock_provider "aws" {}

override_resource {
  target          = aws_iam_openid_connect_provider.github
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
  }
}

variables {
  name_prefix        = "vsp-test"
  account_id         = "111111111111"
  allowed_regions    = ["us-east-1"]
  github_repository  = "example-owner/example-repo"
  github_environment = "sandbox"
  state_bucket_arn   = "arn:aws:s3:::vsp-test-tfstate-111111111111"
  state_key_prefix   = "envs/sandbox/"
}

run "oidc_trust_is_exact" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner/example-repo:environment:sandbox"
    error_message = "[SPEC-15.ci] apply role trusts exactly this repo's protected environment"
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner/example-repo:environment:sandbox-plan"
    error_message = "plan role trusts only the plan environment"
  }

  assert {
    condition     = alltrue([for r in [aws_iam_role.plan, aws_iam_role.apply] : jsondecode(r.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"])
    error_message = "audience pinned to sts.amazonaws.com"
  }

  assert {
    condition     = alltrue([for r in [aws_iam_role.plan, aws_iam_role.apply] : !can(jsondecode(r.assume_role_policy).Statement[0].Condition.StringLike)])
    error_message = "no wildcard (StringLike) subject matching"
  }

  assert {
    condition     = aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"])
    error_message = "OIDC provider audience"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "NoLongLivedCredentials"]), "iam:CreateAccessKey")
    error_message = "[SPEC-14.iam] boundary denies long-lived credentials"
  }

  assert {
    condition     = one([for s in jsondecode(local.boundary_policy).Statement : s.Condition.StringNotEquals["iam:PermissionsBoundary"] if s.Sid == "RolesMustCarryThisBoundary"]) == "arn:aws:iam::111111111111:policy/vsp-test-ci-boundary"
    error_message = "roles created by CI must carry the boundary"
  }

  assert {
    condition     = alltrue([for a in ["rds-db:connect", "sts:AssumeRole"] : contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "MaximumServiceSurface"]), a)])
    error_message = "the boundary admits IAM database auth and the audit-shipper AssumeRole that task roles need"
  }

  assert {
    condition     = length([for s in jsondecode(local.boundary_policy).Statement : s if s.Sid == "NoDestructiveActions"]) == 1
    error_message = "destructive actions denied by default"
  }

  assert {
    condition     = contains(local.data_plane_reads, "dynamodb:Scan") && contains(local.data_plane_reads, "secretsmanager:GetSecretValue") && contains(local.data_plane_reads, "sqs:ReceiveMessage")
    error_message = "[DATA-01] CI roles cannot read session items, secrets or queue messages"
  }

  assert {
    condition     = !contains(keys(local.data_plane_deny), "Condition")
    error_message = "without a state CMK the deny statement has no Condition key at all"
  }
}

run "state_key_exception_is_scoped" {
  command = plan

  variables {
    state_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-00000000000a"
  }

  assert {
    condition     = local.data_plane_deny.Condition.StringNotLike["kms:EncryptionContext:aws:s3:arn"] == "arn:aws:s3:::vsp-test-tfstate-111111111111/envs/sandbox/*"
    error_message = "kms:Decrypt is only usable for the state objects"
  }

  assert {
    condition     = !can(jsondecode(jsonencode(local.data_plane_deny)).Condition) || local.data_plane_deny.Condition != null
    error_message = "no null Condition is ever rendered"
  }
}

run "rejects_wildcard_repository" {
  command = plan

  variables {
    github_repository = "example-owner/*"
  }

  expect_failures = [var.github_repository]
}

run "rejects_wildcard_environment" {
  command = plan

  variables {
    github_environment = "*"
  }

  expect_failures = [var.github_environment]
}
