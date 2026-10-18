# [OPS-01] [SPEC-13.audit] Audit evidence in a SEPARATE account via the aws.audit
# provider: Object Lock with counsel-supplied mode/retention (null rejected),
# versioning, CMK, deny deletes / insecure transport, write-only writer role, separate
# read-only auditor role. Offline: mock providers, plan only.
# Object Lock values below are SYNTHETIC test inputs, not a retention decision.

mock_provider "aws" {
  alias = "audit"
}

# Known key ARN during plan so the rendered bucket policy can be asserted on.
override_resource {
  target          = aws_kms_key.audit
  override_during = plan
  values = {
    arn    = "arn:aws:kms:us-east-1:222222222222:key/00000000-0000-0000-0000-00000000a0d1"
    key_id = "00000000-0000-0000-0000-00000000a0d1"
  }
}

variables {
  name_prefix                = "vsp-test"
  audit_account_id           = "222222222222"
  workload_account_id        = "111111111111"
  region                     = "us-east-1"
  object_lock_mode           = "GOVERNANCE"
  object_lock_retention_days = 1
  writer_principal_arns      = ["arn:aws:iam::111111111111:role/vsp-test-gateway-task", "arn:aws:iam::111111111111:role/vsp-test-worker-task"]
  auditor_principal_arns     = ["arn:aws:iam::222222222222:role/vsp-test-auditor-sso"]
  key_admin_role_arns        = ["arn:aws:iam::222222222222:role/vsp-test-audit-admin"]
}

run "object_locked_separate_account_store" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  assert {
    condition     = aws_s3_bucket.audit.object_lock_enabled == true
    error_message = "[OPS-01] audit bucket has Object Lock enabled"
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.audit.rule[0].default_retention[0].mode == "GOVERNANCE" && aws_s3_bucket_object_lock_configuration.audit.rule[0].default_retention[0].days == 1
    error_message = "Object Lock default retention comes from the supplied variables"
  }

  assert {
    condition     = aws_s3_bucket_versioning.audit.versioning_configuration[0].status == "Enabled"
    error_message = "versioning enabled"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.audit.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
    error_message = "[SPEC-6.encryption] SSE-KMS with the audit-account CMK"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.audit.block_public_policy && aws_s3_bucket_public_access_block.audit.restrict_public_buckets
    error_message = "public access blocked"
  }

  assert {
    condition     = contains([for s in jsondecode(local.bucket_policy).Statement : s.Sid], "DenyAllDeletes") && contains([for s in jsondecode(local.bucket_policy).Statement : s.Sid], "DenyInsecureTransport")
    error_message = "[SPEC-13.audit] bucket policy denies deletes and insecure transport"
  }

  assert {
    condition     = one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyWritesExceptWriterRole"]) == "arn:aws:iam::222222222222:role/vsp-test-audit-writer"
    error_message = "only the writer role can put evidence"
  }

  assert {
    condition     = one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyReadsExceptAuditorRole"]) == "arn:aws:iam::222222222222:role/vsp-test-audit-reader"
    error_message = "only the auditor role can read evidence"
  }

  assert {
    condition     = local.writer_allowed_s3_actions == ["s3:PutObject"] && contains(local.writer_denied_actions, "s3:GetObject*") && contains(local.writer_denied_actions, "s3:DeleteObject*")
    error_message = "[SPEC-13.audit] the cross-account writer can only PutObject"
  }

  assert {
    condition     = jsondecode(aws_iam_role.writer.assume_role_policy).Statement[0].Principal.AWS == "arn:aws:iam::111111111111:root" && jsonencode(jsondecode(aws_iam_role.writer.assume_role_policy).Statement[0].Condition.ArnEquals["aws:PrincipalArn"]) == jsonencode(var.writer_principal_arns)
    error_message = "writer trust is limited to the named workload task roles"
  }

  assert {
    condition     = length(aws_iam_role.auditor) == 1 && aws_iam_role.auditor[0].name != aws_iam_role.writer.name
    error_message = "[SPEC-13.audit] auditor role is separate from the writer role"
  }

  assert {
    condition     = contains(local.auditor_denied_actions, "s3:PutObject*") && length(setintersection(toset(local.auditor_read_actions), toset(["s3:PutObject", "s3:DeleteObject"]))) == 0
    error_message = "auditors cannot rewrite evidence"
  }

  assert {
    condition     = aws_kms_key.audit.enable_key_rotation
    error_message = "audit CMK rotates"
  }

  assert {
    condition     = length(aws_iam_role.verifier) == 0 && output.verifier_role_arn == null
    error_message = "[OPS-AUD-02] no verifier role unless verifier principals are provided"
  }
}

# [OPS-01] [OPS-AUD-02] The platform's automated verifier (audit.verify) gets its own READ-ONLY
# role; writers still cannot read and the verifier cannot write.
run "verifier_role_is_read_only_and_separate_from_writers" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    verifier_principal_arns = ["arn:aws:iam::111111111111:role/vsp-test-audit-verify-task"]
  }

  assert {
    condition     = length(aws_iam_role.verifier) == 1 && aws_iam_role.verifier[0].name == "vsp-test-audit-verifier" && aws_iam_role.verifier[0].name != aws_iam_role.writer.name
    error_message = "[OPS-AUD-02] a separate verifier role exists"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.verifier[0].assume_role_policy).Statement[0].Condition.ArnEquals["aws:PrincipalArn"]) == jsonencode(var.verifier_principal_arns)
    error_message = "[OPS-AUD-02] verifier trust is limited to the named workload verifier task roles"
  }

  assert {
    condition     = local.verifier_read_actions == ["s3:GetObject", "s3:ListBucket"] && contains(local.verifier_denied_actions, "s3:PutObject*") && contains(local.verifier_denied_actions, "s3:DeleteObject*") && contains(local.verifier_denied_actions, "kms:GenerateDataKey*")
    error_message = "[OPS-AUD-02] the verifier can only list and read; it cannot write, delete or encrypt"
  }

  assert {
    condition = (
      contains(one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyReadsExceptAuditorRole"]), "arn:aws:iam::222222222222:role/vsp-test-audit-verifier")
      && contains(one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyReadsExceptAuditorRole"]), "arn:aws:iam::222222222222:role/vsp-test-audit-reader")
      && !contains(one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyReadsExceptAuditorRole"]), "arn:aws:iam::222222222222:role/vsp-test-audit-writer")
    )
    error_message = "[OPS-AUD-02] only the auditor and the verifier may read evidence; never the writer"
  }

  assert {
    condition     = one([for s in jsondecode(local.bucket_policy).Statement : s.Condition.ArnNotEquals["aws:PrincipalArn"] if s.Sid == "DenyWritesExceptWriterRole"]) == "arn:aws:iam::222222222222:role/vsp-test-audit-writer"
    error_message = "[OPS-AUD-02] the verifier is still denied writes by the bucket policy"
  }

  assert {
    condition     = contains([for s in jsondecode(local.key_policy).Statement : s.Sid], "VerifierDecryptsViaS3Only") && local.writer_allowed_s3_actions == ["s3:PutObject"] && contains(local.writer_denied_actions, "s3:GetObject*") && contains(local.writer_denied_actions, "kms:Decrypt")
    error_message = "[OPS-AUD-02] the verifier decrypts via S3 only; the writer stays write-only (no GetObject, no kms:Decrypt)"
  }

  # Wildcard-aware (same check as modules/kms): kms:Create* would match kms:CreateGrant.
  assert {
    condition = alltrue([
      for s in jsondecode(local.key_policy).Statement : try(s.Condition.Bool["kms:GrantIsForAWSResource"], null) == "true"
      if s.Effect == "Allow" && (try(s.Principal.AWS, null) != null || try(s.Principal, null) == "*") && (
        try(s.NotAction, null) == null
        ? anytrue([for a in flatten([try(s.Action, [])]) : can(regex("^(?i)${replace(replace(a, "*", ".*"), "?", ".")}$", "kms:CreateGrant"))])
        : !anytrue([for a in flatten([s.NotAction]) : can(regex("^(?i)${replace(replace(a, "*", ".*"), "?", ".")}$", "kms:CreateGrant"))])
      )
    ])
    error_message = "[SPEC-14.kms] no Allow for an IAM principal on the audit key may match kms:CreateGrant without Bool kms:GrantIsForAWSResource = true"
  }
}

run "rejects_null_object_lock_mode" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    object_lock_mode = null
  }

  expect_failures = [var.object_lock_mode]
}

run "rejects_null_object_lock_retention" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    object_lock_retention_days = null
  }

  expect_failures = [var.object_lock_retention_days]
}

run "rejects_same_account" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    audit_account_id       = "111111111111"
    auditor_principal_arns = []
    key_admin_role_arns    = ["arn:aws:iam::111111111111:role/vsp-test-audit-admin"]
  }

  expect_failures = [terraform_data.account_separation]
}

run "rejects_writer_who_is_also_auditor" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    auditor_principal_arns = ["arn:aws:iam::111111111111:role/vsp-test-gateway-task"]
  }

  expect_failures = [terraform_data.account_separation]
}

run "rejects_writer_who_is_also_verifier" {
  command = plan

  providers = {
    aws.audit = aws.audit
  }

  variables {
    verifier_principal_arns = ["arn:aws:iam::111111111111:role/vsp-test-worker-task"]
  }

  expect_failures = [terraform_data.account_separation]
}
