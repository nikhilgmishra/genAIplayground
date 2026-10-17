# Aurora PostgreSQL 16 business ledger (spec sections 3, 6, 12): Multi-AZ, CMK
# storage encryption, IAM database authentication, TLS forced by the parameter
# group, deletion protection, automated backups, encrypted Performance Insights,
# statement logging disabled so query text (which may contain PHI) does not reach
# logs. Optional Aurora Global Database: the secondary region is read-only until a
# reviewed failover; write forwarding is never enabled (one write region).

locals {
  cluster_identifier = "${var.name_prefix}-ledger"
  is_secondary       = var.cluster_role == "global_secondary"
  log_group_name     = "/aws/rds/cluster/${local.cluster_identifier}/postgresql"

  cluster_parameters = {
    "rds.force_ssl"              = "1"
    "ssl_min_protocol_version"   = "TLSv1.2"
    "password_encryption"        = "scram-sha-256"
    "log_statement"              = "none"
    "log_min_duration_statement" = "-1"
    "log_min_error_statement"    = "panic"
    "log_error_verbosity"        = "terse"
  }
}

resource "terraform_data" "role_guard" {
  input = var.cluster_role

  lifecycle {
    precondition {
      condition     = !local.is_secondary || var.global_cluster_identifier != null
      error_message = "global_secondary requires global_cluster_identifier."
    }
    precondition {
      condition     = local.is_secondary || var.master_user_secret_kms_key_arn != null
      error_message = "master_user_secret_kms_key_arn is required for a primary/standalone cluster."
    }
  }
}

resource "aws_db_subnet_group" "this" {
  name        = "${var.name_prefix}-ledger"
  description = "Private data subnets for the ledger"
  subnet_ids  = var.data_subnet_ids

  tags = var.tags
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-ledger-db"
  description = "Aurora: 5432 from named service security groups only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name_prefix}-ledger-db" })
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  for_each = var.client_security_group_ids

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_vpc_security_group_egress_rule" "clients_to_db" {
  for_each = var.client_security_group_ids

  security_group_id            = each.value
  description                  = "PostgreSQL to the ledger"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${var.name_prefix}-ledger-pg16"
  family      = "aurora-postgresql16"
  description = "Force TLS; no statement or parameter logging"

  dynamic "parameter" {
    for_each = local.cluster_parameters
    content {
      name         = parameter.key
      value        = parameter.value
      apply_method = "pending-reboot"
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "postgresql" {
  name                        = local.log_group_name
  retention_in_days           = var.log_retention_days
  kms_key_id                  = var.logs_kms_key_arn
  deletion_protection_enabled = true

  tags = merge(var.tags, { "vsp:data-class" = "OPERATIONAL_TELEMETRY" })
}

resource "aws_rds_global_cluster" "this" {
  count = var.cluster_role == "global_primary" ? 1 : 0

  global_cluster_identifier = "${var.name_prefix}-ledger-global"
  engine                    = "aurora-postgresql"
  engine_version            = var.engine_version
  database_name             = var.database_name
  storage_encrypted         = true
  deletion_protection       = var.deletion_protection
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = local.cluster_identifier
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version

  global_cluster_identifier = var.cluster_role == "global_primary" ? aws_rds_global_cluster.this[0].id : (local.is_secondary ? var.global_cluster_identifier : null)

  database_name                 = local.is_secondary ? null : var.database_name
  master_username               = local.is_secondary ? null : var.master_username
  manage_master_user_password   = local.is_secondary ? null : true
  master_user_secret_kms_key_id = local.is_secondary ? null : var.master_user_secret_kms_key_arn

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name
  port                            = 5432
  network_type                    = "IPV4"

  storage_encrypted                   = true
  kms_key_id                          = var.storage_kms_key_arn
  iam_database_authentication_enabled = true
  deletion_protection                 = var.deletion_protection
  enable_global_write_forwarding      = false

  backup_retention_period   = var.backup_retention_days
  preferred_backup_window   = var.preferred_backup_window
  copy_tags_to_snapshot     = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.cluster_identifier}-final"
  apply_immediately         = false

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = merge(var.tags, { "vsp:data-class" = "BUSINESS_RECORD" })

  lifecycle {
    ignore_changes = [replication_source_identifier]
  }

  depends_on = [aws_cloudwatch_log_group.postgresql, terraform_data.role_guard]
}

resource "aws_rds_cluster_instance" "this" {
  count = var.instance_count

  identifier           = "${local.cluster_identifier}-${count.index + 1}"
  cluster_identifier   = aws_rds_cluster.this.id
  engine               = aws_rds_cluster.this.engine
  engine_version       = var.engine_version
  instance_class       = var.instance_class
  db_subnet_group_name = aws_db_subnet_group.this.name
  availability_zone    = var.availability_zones[count.index % length(var.availability_zones)]
  promotion_tier       = count.index

  publicly_accessible        = false
  auto_minor_version_upgrade = false
  ca_cert_identifier         = "rds-ca-rsa2048-g1"
  copy_tags_to_snapshot      = true
  apply_immediately          = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.storage_kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_days

  tags = merge(var.tags, { "vsp:data-class" = "BUSINESS_RECORD" })
}
