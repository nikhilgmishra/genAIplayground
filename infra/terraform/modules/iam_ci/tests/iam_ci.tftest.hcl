# [SPEC-15.ci] [SPEC-14.iam] GitHub OIDC federation: exact repo + environment +
# deploy workflow@main subjects, audience sts.amazonaws.com, permissions boundary, no
# long-lived keys, the listed data-plane reads and export/sharing calls denied (residual
# resource-policy paths are documented in infra/terraform/README.md), no self-modification
# or escalation through pre-existing roles (VSP-INF-02), read-only state for plan (VSP-INF-03).
# Offline: mock provider, plan only. The semantic escalation probes run in the OPA
# policy (infra/terraform/policy, rule CI-BOUNDARY) against the rendered boundary.

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
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner/example-repo:environment:sandbox:job_workflow_ref:example-owner/example-repo/.github/workflows/deploy.yml@refs/heads/main"
    error_message = "[SPEC-15.ci][VSP-INF-03] apply role trusts exactly this repo's protected environment, from deploy.yml on main"
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner/example-repo:environment:sandbox-plan:job_workflow_ref:example-owner/example-repo/.github/workflows/deploy.yml@refs/heads/main"
    error_message = "[VSP-INF-03] plan role trusts only the plan environment, from deploy.yml on main (a job on another branch or in another workflow gets a different subject)"
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

run "ci_identity_is_immutable_to_ci" {
  command = plan

  # [VSP-INF-02] the boundary (which CI cannot change) denies CI any change to its own roles.
  assert {
    condition = alltrue([for a in ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:UpdateRole", "iam:DeleteRole", "iam:PassRole", "iam:TagRole", "iam:UntagRole"] :
      contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "CiIdentityIsImmutableToCi" && s.Effect == "Deny"]), a)
    ])
    error_message = "[VSP-INF-02] CI roles cannot rewrite their own inline or attached policies, trust, boundary or role settings, or pass themselves to a service"
  }

  assert {
    condition     = toset(one([for s in jsondecode(local.boundary_policy).Statement : s.Resource if s.Sid == "CiIdentityIsImmutableToCi"])) == toset(["arn:aws:iam::111111111111:role/vsp-test-gha-plan", "arn:aws:iam::111111111111:role/vsp-test-gha-apply"])
    error_message = "[VSP-INF-02] the self-modification deny names exactly both CI roles"
  }

  assert {
    condition     = toset([aws_iam_role.plan.name, aws_iam_role.apply.name]) == toset(["vsp-test-gha-plan", "vsp-test-gha-apply"])
    error_message = "[VSP-INF-02] the role names match the ARNs the boundary protects"
  }

  # [VSP-INF-02] role-policy changes only on roles that carry this boundary (not on pre-existing roles).
  assert {
    condition = alltrue([for a in ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"] :
      contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "RolesMustCarryThisBoundary"]), a)
    ])
    error_message = "[VSP-INF-02] creating roles and changing role policies require this boundary on the target role"
  }

  # [VSP-INF-02] trust, settings and PassRole only for roles CI creates (name prefix).
  assert {
    condition = alltrue([for a in ["iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:DeleteRole", "iam:PassRole", "iam:TagRole", "iam:UntagRole"] :
      contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "OnlyRolesCreatedByCiCanBeChangedOrPassed" && s.Effect == "Deny"]), a)
    ])
    error_message = "[VSP-INF-02] CI cannot retarget the trust of, change, delete or pass a role it did not create"
  }

  assert {
    condition     = one([for s in jsondecode(local.boundary_policy).Statement : s.NotResource if s.Sid == "OnlyRolesCreatedByCiCanBeChangedOrPassed"]) == ["arn:aws:iam::111111111111:role/vsp-test-*"]
    error_message = "[VSP-INF-02] the role-change scope is exactly this stack's name prefix"
  }

  # [VSP-INF-02] no assuming in-account roles (e.g. a pre-existing admin role that trusts the account).
  assert {
    condition = length([for s in jsondecode(local.boundary_policy).Statement : s if
      s.Sid == "NoInAccountRoleAssumption" && s.Effect == "Deny" && s.Action == ["sts:AssumeRole"] && s.Resource == ["arn:aws:iam::111111111111:role/*"]
    ]) == 1
    error_message = "[VSP-INF-02] CI and CI-created roles cannot assume roles in this account (the audit-account role is cross-account)"
  }

  # [VSP-INF-02][OPS-05] the data-plane deny for CI principals lives in the boundary, which CI cannot change:
  # every listed read (data_plane_reads) and every listed export/sharing call (data_plane_exports).
  assert {
    condition = length([for s in jsondecode(local.boundary_policy).Statement : s if
      s.Sid == "NoDataPlaneReadsForCi" && s.Effect == "Deny" && toset(s.Action) == toset(concat(local.data_plane_reads, local.data_plane_exports)) &&
      toset(s.Condition.ArnEquals["aws:PrincipalArn"]) == toset(["arn:aws:iam::111111111111:role/vsp-test-gha-plan", "arn:aws:iam::111111111111:role/vsp-test-gha-apply"])
    ]) == 1
    error_message = "[VSP-INF-02][OPS-05] the boundary denies CI principals the listed reads (session items, secrets, queue messages, logs, decrypt) and the listed export and sharing calls, independent of their inline policies (residual paths: README)"
  }

  assert {
    condition     = alltrue([for a in ["dynamodb:GetItem", "dynamodb:Scan", "secretsmanager:GetSecretValue", "sqs:ReceiveMessage", "logs:FilterLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "rds:DownloadDBLogFilePortion", "xray:BatchGetTraces", "ssm:GetParameter", "ec2:GetPasswordData", "kms:Decrypt"] : contains(local.data_plane_reads, a)])
    error_message = "[OPS-05] the data-plane read list covers the data-bearing reads that ReadOnlyAccess grants for services in this stack"
  }

  assert {
    condition     = alltrue([for a in ["iam:CreateOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint", "iam:AddClientIDToOpenIDConnectProvider", "iam:CreateSAMLProvider"] : contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "NoIdentityProviderChanges"]), a)])
    error_message = "[VSP-INF-02] CI cannot add or change identity providers (no persistence through a new federation)"
  }

  assert {
    condition     = alltrue([for a in ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion"] : contains(one([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "NoManagedPolicyChanges"]), a)])
    error_message = "[VSP-INF-02] CI cannot create or rewrite managed policies (they could widen a pre-existing principal)"
  }

  assert {
    condition     = alltrue([for a in ["iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:AttachGroupPolicy", "iam:PutGroupPolicy", "iam:AddUserToGroup", "iam:CreateServiceSpecificCredential"] : contains(flatten([for s in jsondecode(local.boundary_policy).Statement : s.Action if s.Sid == "NoLongLivedCredentials"]), a)])
    error_message = "[VSP-INF-02] no user, group or long-lived credential changes"
  }

  assert {
    condition     = length(replace(local.boundary_policy, "/\\s/", "")) <= 6144
    error_message = "the boundary fits the 6,144-character managed policy limit"
  }
}

run "ci_cannot_export_or_share_data" {
  command = plan

  variables {
    state_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-00000000000a"
  }

  # [OPS-05][VSP-INF-02] data-moving calls this stack never makes are denied to both CI roles, in the
  # boundary (which CI cannot change) and in their inline policies: table export to S3 (including the
  # state prefix, which the apply role can read back), table resource policies, snapshot sharing and
  # export, log export and subscription filters, bucket replication and ACLs, legacy queue permissions.
  assert {
    condition = alltrue([for a in [
      "dynamodb:ExportTableToPointInTime", "dynamodb:PutResourcePolicy", "rds:ModifyDBClusterSnapshotAttribute", "rds:ModifyDBSnapshotAttribute",
      "rds:StartExportTask", "logs:CreateExportTask", "logs:PutSubscriptionFilter", "s3:PutReplicationConfiguration", "s3:PutBucketAcl",
      "s3:PutObjectAcl", "sqs:AddPermission",
    ] : contains(local.data_plane_exports, a)])
    error_message = "[OPS-05][VSP-INF-02] the export and sharing list names every data-moving call this stack never makes"
  }

  assert {
    condition = length([for s in jsondecode(local.boundary_policy).Statement : s if
      s.Sid == "NoDataPlaneReadsForCi" && s.Effect == "Deny" &&
      alltrue([for a in concat(local.data_plane_reads, local.data_plane_exports) : contains(s.Action, a)])
    ]) == 1
    error_message = "[OPS-05][VSP-INF-02] the boundary denies the CI roles every listed read, export and sharing call"
  }

  assert {
    condition = alltrue([for p in [aws_iam_role_policy.plan.policy, aws_iam_role_policy.apply.policy] : length([for s in jsondecode(p).Statement : s if
      s.Sid == "NoDataPlaneReads" && s.Effect == "Deny" && toset(s.Action) == toset(concat(local.data_plane_reads, local.data_plane_exports))
    ]) == 1])
    error_message = "[OPS-05][VSP-INF-02] both inline policies carry the same read, export and sharing deny as the boundary"
  }

  # [OPS-05][VSP-INF-02] the sharing calls Terraform does make are scoped by condition for every role under
  # the boundary (no principal condition): KMS grants only when an AWS service creates them for a
  # resource, secret policies only with Block Public Policy.
  assert {
    condition = length([for s in jsondecode(local.boundary_policy).Statement : s if
      s.Sid == "SharingOnlyViaAwsServicesOrPrivately" && s.Effect == "Deny" && s.Resource == "*" &&
      toset(s.Action) == toset(["kms:CreateGrant", "secretsmanager:PutResourcePolicy"]) &&
      s.Condition == { BoolIfExists = { "kms:GrantIsForAWSResource" = "false", "secretsmanager:BlockPublicPolicy" = "false" } }
    ]) == 1
    error_message = "[OPS-05][VSP-INF-02] CI and the roles it creates may create KMS grants only through an AWS service and secret policies only with Block Public Policy"
  }

  # The exports never overlap what Terraform calls for this stack (bucket, queue, key and secret policies stay allowed).
  assert {
    condition     = length(setintersection(toset(local.data_plane_exports), toset(["s3:PutBucketPolicy", "sqs:SetQueueAttributes", "kms:PutKeyPolicy", "secretsmanager:PutResourcePolicy", "logs:PutResourcePolicy", "dynamodb:UpdateTable", "rds:ModifyDBCluster"]))) == 0
    error_message = "the export deny must not block resource policies this stack manages (residual risk documented in the README)"
  }
}

run "boundary_fits_with_longest_inputs" {
  command = plan

  # Worst case for the 6,144-character managed-policy limit: longest prefix, two regions, state CMK.
  variables {
    name_prefix       = "vsp-production-dr-abcdefg"
    allowed_regions   = ["us-east-1", "us-west-2"]
    state_bucket_arn  = "arn:aws:s3:::vsp-production-dr-terraform-state-111111111111-us-east-1x"
    state_key_prefix  = "envs/production-dr/"
    state_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-00000000000a"
  }

  assert {
    condition     = length(replace(local.boundary_policy, "/\\s/", "")) <= 6144
    error_message = "the boundary fits the 6,144-character managed policy limit with the longest allowed inputs"
  }
}

run "plan_role_is_read_only_on_state" {
  command = plan

  variables {
    state_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-00000000000a"
  }

  # [VSP-INF-03] terraform plan only writes and removes <key>.tflock (use_lockfile = true).
  assert {
    condition = alltrue(flatten([for s in jsondecode(aws_iam_role_policy.plan.policy).Statement : [
      for r in s.Resource : endswith(r, ".tflock")
    ] if s.Effect == "Allow" && (contains(s.Action, "s3:PutObject") || contains(s.Action, "s3:DeleteObject"))]))
    error_message = "[VSP-INF-03] the plan role may write or delete only Terraform lock objects, never the state"
  }

  assert {
    condition = length([for s in jsondecode(aws_iam_role_policy.plan.policy).Statement : s if
      s.Effect == "Deny" && contains(s.Action, "s3:PutObject") && contains(s.Action, "s3:DeleteObject") && contains(s.Action, "s3:DeleteObjectVersion") &&
      s.NotResource == ["arn:aws:s3:::vsp-test-tfstate-111111111111/envs/sandbox/*.tflock"]
    ]) == 1
    error_message = "[VSP-INF-03] an explicit deny keeps every object but the lock read-only for the plan role"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.plan.policy).Statement :
    s.Effect == "Allow" && contains(s.Action, "s3:GetObject") && s.Resource == ["arn:aws:s3:::vsp-test-tfstate-111111111111/envs/sandbox/*"]])
    error_message = "the plan role still reads the state"
  }

  # [VSP-INF-03] apply overwrites state but never deletes it (only the lock).
  assert {
    condition = alltrue(flatten([for s in jsondecode(aws_iam_role_policy.apply.policy).Statement : [
      for r in s.Resource : endswith(r, ".tflock")
    ] if s.Effect == "Allow" && contains(s.Action, "s3:DeleteObject")]))
    error_message = "[VSP-INF-03] the apply role deletes only lock objects"
  }

  assert {
    condition = length([for s in jsondecode(aws_iam_role_policy.apply.policy).Statement : s if
      s.Effect == "Deny" && contains(s.Action, "s3:DeleteObject") && contains(s.Action, "s3:DeleteObjectVersion") &&
      s.NotResource == ["arn:aws:s3:::vsp-test-tfstate-111111111111/envs/sandbox/*.tflock"]
    ]) == 1
    error_message = "[VSP-INF-03] DeployServices grants s3:*, so an explicit deny keeps the apply role from deleting the state (only the lock)"
  }

  assert {
    condition = alltrue([for p in [aws_iam_role_policy.plan.policy, aws_iam_role_policy.apply.policy] : length([for s in jsondecode(p).Statement : s if
      s.Sid == "StateBucketIsNotManagedByCi" && s.Effect == "Deny" && s.Resource == ["arn:aws:s3:::vsp-test-tfstate-111111111111"] &&
      contains(s.Action, "s3:PutBucket*") && contains(s.Action, "s3:PutLifecycleConfiguration")
    ]) == 1])
    error_message = "[VSP-INF-03] neither CI role can change the state bucket's policy, versioning or lifecycle (its recovery control)"
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.apply.policy).Statement :
    s.Effect == "Allow" && contains(s.Action, "s3:PutObject") && s.Resource == ["arn:aws:s3:::vsp-test-tfstate-111111111111/envs/sandbox/*"]])
    error_message = "the apply role still writes the state"
  }
}

run "rejects_wildcard_deploy_ref" {
  command = plan

  variables {
    github_deploy_ref = "refs/heads/*"
  }

  expect_failures = [var.github_deploy_ref]
}

run "rejects_workflow_outside_github_workflows" {
  command = plan

  variables {
    github_deploy_workflow = "../evil.yml"
  }

  expect_failures = [var.github_deploy_workflow]
}
