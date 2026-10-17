# [SPEC-3.aurora] [SPEC-6.encryption] Aurora PostgreSQL 16: Multi-AZ, CMK storage,
# IAM auth, forced TLS, deletion protection, backups, encrypted Performance Insights,
# no statement logging; DR secondary read-only (no write forwarding).
# Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix                    = "vsp-test"
  vpc_id                         = "vpc-0123456789abcdef0"
  data_subnet_ids                = ["subnet-0000000000000000d", "subnet-0000000000000000e", "subnet-0000000000000000f"]
  availability_zones             = ["us-east-1a", "us-east-1b", "us-east-1c"]
  client_security_group_ids      = { gateway = "sg-0000000000000000a", worker = "sg-0000000000000000b" }
  engine_version                 = "16.6"
  instance_class                 = "db.r7g.large"
  storage_kms_key_arn            = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000003"
  master_user_secret_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000002"
  backup_retention_days          = 7
  log_retention_days             = 30
  logs_kms_key_arn               = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
}

run "encrypted_multi_az_iam_auth" {
  command = plan

  assert {
    condition     = aws_rds_cluster.this.storage_encrypted && aws_rds_cluster.this.kms_key_id == var.storage_kms_key_arn
    error_message = "[SPEC-6.encryption] storage encrypted with the CMK"
  }

  assert {
    condition     = aws_rds_cluster.this.iam_database_authentication_enabled && aws_rds_cluster.this.deletion_protection
    error_message = "IAM database authentication and deletion protection"
  }

  assert {
    condition     = aws_rds_cluster.this.manage_master_user_password == true
    error_message = "[AUTH-06] no master password in Terraform; RDS manages it in Secrets Manager"
  }

  assert {
    condition     = length(aws_rds_cluster_instance.this) == 2 && aws_rds_cluster_instance.this[0].availability_zone != aws_rds_cluster_instance.this[1].availability_zone
    error_message = "[SPEC-12.recovery] writer and reader are in different AZs"
  }

  assert {
    condition     = alltrue([for i in aws_rds_cluster_instance.this : i.publicly_accessible == false && i.performance_insights_enabled && i.performance_insights_kms_key_id == var.storage_kms_key_arn])
    error_message = "instances are private and Performance Insights is CMK encrypted"
  }

  assert {
    condition     = local.cluster_parameters["rds.force_ssl"] == "1" && local.cluster_parameters["log_statement"] == "none"
    error_message = "[SPEC-14.tls] TLS is forced; statement logging is off (query text may contain PHI)"
  }

  assert {
    condition     = aws_rds_cluster.this.backup_retention_period == 7 && aws_rds_cluster.this.skip_final_snapshot == false
    error_message = "backups and final snapshot"
  }

  assert {
    condition     = aws_rds_cluster.this.enable_global_write_forwarding == false
    error_message = "[SPEC-12.fence] write forwarding is never enabled"
  }

  assert {
    condition     = aws_cloudwatch_log_group.postgresql.kms_key_id == var.logs_kms_key_arn
    error_message = "exported logs are KMS encrypted"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.from_clients) == 2
    error_message = "only the named client security groups reach 5432"
  }

  assert {
    condition     = length(aws_rds_global_cluster.this) == 0
    error_message = "standalone by default"
  }
}

run "global_primary" {
  command = plan

  variables {
    cluster_role = "global_primary"
  }

  assert {
    condition     = length(aws_rds_global_cluster.this) == 1 && aws_rds_global_cluster.this[0].storage_encrypted
    error_message = "global primary creates an encrypted global cluster"
  }
}

run "global_secondary_is_read_only" {
  command = plan

  variables {
    cluster_role              = "global_secondary"
    global_cluster_identifier = "vsp-test-ledger-global"
  }

  assert {
    condition     = aws_rds_cluster.this.global_cluster_identifier == "vsp-test-ledger-global" && local.is_secondary
    error_message = "secondary joins the global cluster without its own credentials"
  }

  assert {
    condition     = aws_rds_cluster.this.enable_global_write_forwarding == false
    error_message = "[SPEC-12.fence] DR secondary never forwards writes"
  }
}

run "rejects_single_instance" {
  command = plan

  variables {
    instance_count = 1
  }

  expect_failures = [var.instance_count]
}

run "rejects_non_pg16" {
  command = plan

  variables {
    engine_version = "15.4"
  }

  expect_failures = [var.engine_version]
}
