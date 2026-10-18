# Independently administered audit evidence store (spec sections 3, 6 and 13).
# EVERY resource uses the aws.audit provider (the separate AUDIT ACCOUNT).
#  - S3 bucket with Object Lock (mode and retention REQUIRED from counsel/security),
#    versioning, SSE-KMS with an audit-account CMK, public access blocked.
#  - Bucket policy: TLS only, no deletes by anyone, no governance bypass, writes only
#    by the writer role, reads only by the auditor role.
#  - Cross-account WRITE-ONLY role for the gateway/worker shippers (PutObject only). It can
#    never read evidence back: S3 authorizes HeadObject as s3:GetObject, and returning the
#    stored checksum of an SSE-KMS object needs kms:Decrypt; both are denied. The platform
#    sink therefore resolves a 412 on its own deterministic key WITHOUT reading it
#    (platform/src/audit/sinks/s3-object-lock.ts, existingObjectCheck "defer_to_verifier").
#  - Separate READ-ONLY auditor role (humans, audit account). Auditors cannot write.
#  - Optional READ-ONLY verifier role (OPS-AUD-02) for the platform's automated verifier
#    (worker loop audit.verify -> IntegrityVerifier.verifyShipped), assumable only by
#    workload task roles that are NOT writers; created when verifier_principal_arns is set.
#    Writers cannot read; readers cannot write.
# Hashing/signing alone does not prove completeness. The platform's audit.verify loop
# (platform/src/audit/monitor.ts) verifies local and shipped integrity, compares the writer
# chain heads with the rows present, reconciles COMMITTED ledger actions with their commit
# audit events, and publishes vsp_audit_ingestion_gaps_total / vsp_audit_export_completeness_ratio
# / vsp_audit_backlog_events. Verifying shipped objects in a live account needs the verifier role
# (BLOCKED until verifier_principal_arns and the live composition exist); without it the
# verdict is INCONCLUSIVE, never PASS.

locals {
  bucket_name            = "${var.name_prefix}-audit-${var.audit_account_id}"
  access_log_bucket_name = "${var.name_prefix}-audit-access-${var.audit_account_id}"
  writer_role_name       = "${var.name_prefix}-audit-writer"
  auditor_role_name      = "${var.name_prefix}-audit-reader"
  verifier_role_name     = "${var.name_prefix}-audit-verifier"
  writer_role_arn        = "arn:${var.partition}:iam::${var.audit_account_id}:role/${local.writer_role_name}"
  auditor_role_arn       = "arn:${var.partition}:iam::${var.audit_account_id}:role/${local.auditor_role_name}"
  verifier_role_arn      = "arn:${var.partition}:iam::${var.audit_account_id}:role/${local.verifier_role_name}"
  bucket_arn             = "arn:${var.partition}:s3:::${local.bucket_name}"
  access_log_bucket_arn  = "arn:${var.partition}:s3:::${local.access_log_bucket_name}"
  audit_root             = "arn:${var.partition}:iam::${var.audit_account_id}:root"
  workload_root          = "arn:${var.partition}:iam::${var.workload_account_id}:root"
  create_auditor         = length(var.auditor_principal_arns) > 0
  create_verifier        = length(var.verifier_principal_arns) > 0
  # Principals exempt from DenyReadsExceptAuditorRole: the auditor, plus the verifier when configured.
  # Unchanged single ARN when no verifier exists; the writer is never a reader.
  # (Both branches go through jsonencode so the types agree; without a verifier the value is the same single ARN string.)
  evidence_reader_arns = jsondecode(local.create_verifier ? jsonencode([local.auditor_role_arn, local.verifier_role_arn]) : jsonencode(local.auditor_role_arn))

  writer_allowed_s3_actions = ["s3:PutObject"]
  writer_denied_actions     = ["s3:GetObject*", "s3:ListBucket*", "s3:DeleteObject*", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "kms:Decrypt"]
  auditor_read_actions = [
    "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention", "s3:GetObjectLegalHold",
    "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketObjectLockConfiguration",
  ]
  auditor_denied_actions = ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:BypassGovernanceRetention", "kms:GenerateDataKey*", "kms:Encrypt"]
  # Verifier: list + read evidence objects only (no versions, retention or legal-hold reads needed).
  verifier_read_actions   = ["s3:GetObject", "s3:ListBucket"]
  verifier_denied_actions = ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:BypassGovernanceRetention", "kms:GenerateDataKey*", "kms:Encrypt"]

  verifier_key_statements = local.create_verifier ? [{
    Sid       = "VerifierDecryptsViaS3Only"
    Effect    = "Allow"
    Principal = { AWS = local.audit_root }
    Action    = ["kms:Decrypt", "kms:DescribeKey"]
    Resource  = "*"
    Condition = {
      ArnEquals    = { "aws:PrincipalArn" = local.verifier_role_arn }
      StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
    }
  }] : []

  key_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "KeyAdministrationWithoutCryptographicUse"
        Effect    = "Allow"
        Principal = { AWS = var.key_admin_role_arns }
        # kms:CreateAlias, never kms:Create*: it matches kms:CreateGrant, and an unconditioned
        # grant would let an administrator give itself (or another account) Decrypt on the
        # evidence key. S3 SSE-KMS needs no grants, so administrators get none.
        Action = [
          "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*",
          "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:TagResource", "kms:UntagResource",
          "kms:CancelKeyDeletion", "kms:RotateKeyOnDemand",
        ]
        Resource = "*"
      },
      {
        Sid       = "WriterGeneratesDataKeysViaS3Only"
        Effect    = "Allow"
        Principal = { AWS = local.audit_root }
        Action    = ["kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          ArnEquals    = { "aws:PrincipalArn" = local.writer_role_arn }
          StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
        }
      },
      {
        Sid       = "AuditorDecryptsViaS3Only"
        Effect    = "Allow"
        Principal = { AWS = local.audit_root }
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnEquals    = { "aws:PrincipalArn" = local.auditor_role_arn }
          StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
        }
      },
    ], local.verifier_key_statements)
  })

  bucket_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyAllDeletes"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteBucket", "s3:DeleteBucketPolicy"]
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
      },
      {
        Sid       = "DenyGovernanceBypass"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:BypassGovernanceRetention"]
        Resource  = "${local.bucket_arn}/*"
      },
      {
        Sid       = "DenyLockAndVersioningChangesExceptAdmins"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutBucketObjectLockConfiguration", "s3:PutBucketVersioning", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration"]
        Resource  = local.bucket_arn
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.key_admin_role_arns } }
      },
      {
        Sid       = "DenyWritesExceptWriterRole"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject"]
        Resource  = "${local.bucket_arn}/*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = local.writer_role_arn } }
      },
      {
        Sid       = "DenyNonKmsOrForeignKeyWrites"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject"]
        Resource  = "${local.bucket_arn}/*"
        Condition = {
          StringNotEqualsIfExists = {
            "s3:x-amz-server-side-encryption"                = "aws:kms"
            "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.audit.arn
          }
        }
      },
      {
        Sid       = "DenyReadsExceptAuditorRole"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource  = "${local.bucket_arn}/*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = local.evidence_reader_arns } }
      },
      {
        Sid       = "DenyRetentionAndLegalHoldChangesExceptLegalHoldRoles"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObjectRetention", "s3:PutObjectLegalHold"]
        Resource  = "${local.bucket_arn}/*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = length(var.legal_hold_role_arns) == 0 ? ["arn:${var.partition}:iam::${var.audit_account_id}:role/NO-LEGAL-HOLD-ROLE-CONFIGURED"] : var.legal_hold_role_arns } }
      },
    ]
  })
}

resource "terraform_data" "account_separation" {
  input = var.audit_account_id

  lifecycle {
    precondition {
      condition     = var.audit_account_id != var.workload_account_id
      error_message = "The audit account must be separate from the workload account (spec section 13)."
    }
    precondition {
      condition     = length(setintersection(toset(var.writer_principal_arns), toset(var.auditor_principal_arns))) == 0
      error_message = "Audit-view principals cannot also be evidence writers (spec section 13)."
    }
    precondition {
      condition     = alltrue([for a in var.writer_principal_arns : split(":", a)[4] == var.workload_account_id])
      error_message = "writer_principal_arns must be roles in the workload account."
    }
    precondition {
      condition     = length(setintersection(toset(var.writer_principal_arns), toset(var.verifier_principal_arns))) == 0
      error_message = "Evidence writers cannot also be verifiers (writers cannot read evidence; OPS-AUD-02): run audit.verify under its own task role."
    }
    precondition {
      condition     = alltrue([for a in var.verifier_principal_arns : split(":", a)[4] == var.workload_account_id])
      error_message = "verifier_principal_arns must be roles in the workload account."
    }
  }
}

resource "aws_kms_key" "audit" {
  provider = aws.audit

  description              = "${var.name_prefix} SECURITY_AUDIT evidence"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  rotation_period_in_days  = 365
  deletion_window_in_days  = 30
  policy                   = local.key_policy

  tags = merge(var.tags, { "vsp:data-class" = "SECURITY_AUDIT" })
}

resource "aws_kms_alias" "audit" {
  provider = aws.audit

  name          = "alias/${var.name_prefix}-audit-evidence"
  target_key_id = aws_kms_key.audit.key_id
}

# ---------------------------------------------------------------- access logs of the audit bucket
resource "aws_s3_bucket" "access_logs" {
  provider = aws.audit

  bucket        = local.access_log_bucket_name
  force_destroy = false

  tags = merge(var.tags, {
    "vsp:data-class"           = "SECURITY_AUDIT"
    "vsp:encryption-exception" = "s3-server-access-log-target-requires-sse-s3"
  })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  provider = aws.audit

  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  provider = aws.audit

  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  provider = aws.audit

  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  provider = aws.audit

  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  provider = aws.audit

  bucket = aws_s3_bucket.access_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "S3ServerAccessLogDelivery"
        Effect    = "Allow"
        Principal = { Service = "logging.s3.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.access_log_bucket_arn}/audit-bucket/*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.audit_account_id }
          ArnLike      = { "aws:SourceArn" = local.bucket_arn }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.access_log_bucket_arn, "${local.access_log_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyAllDeletes"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${local.access_log_bucket_arn}/*"
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

# ---------------------------------------------------------------- evidence bucket
resource "aws_s3_bucket" "audit" {
  provider = aws.audit

  bucket              = local.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  tags = merge(var.tags, { "vsp:data-class" = "SECURITY_AUDIT", "vsp:object-lock" = "required" })
}

resource "aws_s3_bucket_public_access_block" "audit" {
  provider = aws.audit

  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  provider = aws.audit

  bucket = aws_s3_bucket.audit.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  provider = aws.audit

  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  provider = aws.audit

  bucket = aws_s3_bucket.audit.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.object_lock_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  provider = aws.audit

  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_logging" "audit" {
  provider = aws.audit

  bucket        = aws_s3_bucket.audit.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "audit-bucket/"
}

resource "aws_s3_bucket_policy" "audit" {
  provider = aws.audit

  bucket = aws_s3_bucket.audit.id
  policy = local.bucket_policy

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

# ---------------------------------------------------------------- roles
resource "aws_iam_role" "writer" {
  provider = aws.audit

  name                 = local.writer_role_name
  description          = "Write-only evidence shipper role assumed by workload task roles"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "WorkloadShippersOnly"
      Effect    = "Allow"
      Principal = { AWS = local.workload_root }
      Action    = "sts:AssumeRole"
      Condition = { ArnEquals = { "aws:PrincipalArn" = var.writer_principal_arns } }
    }]
  })

  tags = merge(var.tags, { "vsp:audit-role" = "writer" })

  depends_on = [terraform_data.account_separation]
}

resource "aws_iam_role_policy" "writer" {
  provider = aws.audit

  name = "put-evidence-only"
  role = aws_iam_role.writer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PutEvidenceObjects"
        Effect   = "Allow"
        Action   = local.writer_allowed_s3_actions
        Resource = "${local.bucket_arn}/${var.evidence_prefix}*"
      },
      {
        Sid       = "GenerateDataKeysViaS3"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = aws_kms_key.audit.arn
        Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "WritersCannotReadOrDelete"
        Effect   = "Deny"
        Action   = local.writer_denied_actions
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role" "auditor" {
  provider = aws.audit
  count    = local.create_auditor ? 1 : 0

  name                 = local.auditor_role_name
  description          = "Read-only audit evidence role (separate from writers)"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "NamedAuditorsOnly"
      Effect    = "Allow"
      Principal = { AWS = local.audit_root }
      Action    = "sts:AssumeRole"
      Condition = { ArnEquals = { "aws:PrincipalArn" = var.auditor_principal_arns } }
    }]
  })

  tags = merge(var.tags, { "vsp:audit-role" = "auditor" })

  depends_on = [terraform_data.account_separation]
}

resource "aws_iam_role_policy" "auditor" {
  provider = aws.audit
  count    = local.create_auditor ? 1 : 0

  name = "read-evidence-only"
  role = aws_iam_role.auditor[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadEvidence"
        Effect   = "Allow"
        Action   = local.auditor_read_actions
        Resource = [local.bucket_arn, "${local.bucket_arn}/*", local.access_log_bucket_arn, "${local.access_log_bucket_arn}/*"]
      },
      {
        Sid       = "DecryptViaS3"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = aws_kms_key.audit.arn
        Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "AuditorsCannotWrite"
        Effect   = "Deny"
        Action   = local.auditor_denied_actions
        Resource = "*"
      },
    ]
  })
}

# ---------------------------------------------------------------- verifier (OPS-AUD-02)
resource "aws_iam_role" "verifier" {
  provider = aws.audit
  count    = local.create_verifier ? 1 : 0

  name                 = local.verifier_role_name
  description          = "Read-only evidence verifier for the platform audit.verify loop (cannot write; separate from writers)"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "WorkloadVerifiersOnly"
      Effect    = "Allow"
      Principal = { AWS = local.workload_root }
      Action    = "sts:AssumeRole"
      Condition = { ArnEquals = { "aws:PrincipalArn" = var.verifier_principal_arns } }
    }]
  })

  tags = merge(var.tags, { "vsp:audit-role" = "verifier" })

  depends_on = [terraform_data.account_separation]
}

resource "aws_iam_role_policy" "verifier" {
  provider = aws.audit
  count    = local.create_verifier ? 1 : 0

  name = "verify-evidence-read-only"
  role = aws_iam_role.verifier[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ListEvidencePrefix"
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = local.bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["${var.evidence_prefix}*"] } }
      },
      {
        Sid      = "ReadEvidenceObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${local.bucket_arn}/${var.evidence_prefix}*"
      },
      {
        Sid       = "DecryptViaS3"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = aws_kms_key.audit.arn
        Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "VerifiersCannotWrite"
        Effect   = "Deny"
        Action   = local.verifier_denied_actions
        Resource = "*"
      },
    ]
  })
}
