variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
  nullable    = false
}

variable "data_subnet_ids" {
  description = "Private data subnets (no internet route), >= 3 AZs."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.data_subnet_ids) >= 3
    error_message = "Aurora must use subnets in at least three availability zones."
  }
}

variable "availability_zones" {
  description = "AZs used to spread instances (writer and readers in different AZs)."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.availability_zones) >= 3
    error_message = "At least three availability zones are required."
  }
}

variable "client_security_group_ids" {
  description = "Security groups of the services allowed to connect on 5432 (keys are stable names; this module adds both sides of each rule)."
  type        = map(string)
  nullable    = false
}

variable "cluster_role" {
  description = "standalone | global_primary (creates the Aurora Global Database and its primary) | global_secondary (joins global_cluster_identifier as a read-only secondary in the DR region)."
  type        = string
  default     = "standalone"

  validation {
    condition     = contains(["standalone", "global_primary", "global_secondary"], var.cluster_role)
    error_message = "cluster_role must be standalone, global_primary or global_secondary."
  }
}

variable "global_cluster_identifier" {
  description = "Existing global cluster to join (global_secondary only)."
  type        = string
  default     = null
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version (PostgreSQL 16 compatible). No default: confirm the exact minor version is offered in the target region before plan (aws rds describe-db-engine-versions)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^16\\.[0-9]+$", var.engine_version))
    error_message = "engine_version must be an Aurora PostgreSQL 16.x version."
  }
}

variable "instance_class" {
  description = "Instance class. No default: sizing comes from load tests (spec section 12), not from this module."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^db\\.", var.instance_class))
    error_message = "instance_class must be an RDS instance class (db.*)."
  }
}

variable "instance_count" {
  description = "Writer + readers. >= 2 so an acknowledged commit survives an AZ failure with a reader to promote."
  type        = number
  default     = 2

  validation {
    condition     = var.instance_count >= 2
    error_message = "instance_count must be >= 2 (Multi-AZ)."
  }
}

variable "storage_kms_key_arn" {
  description = "CMK for cluster storage, snapshots and Performance Insights (BUSINESS_RECORD key)."
  type        = string
  nullable    = false
}

variable "master_user_secret_kms_key_arn" {
  description = "CMK for the RDS-managed master user secret (no password is ever set in Terraform)."
  type        = string
  default     = null
}

variable "backup_retention_days" {
  description = "Automated backup retention (1-35 days). No default: set by security/privacy in the retention matrix with the recovery owner."
  type        = number
  nullable    = false

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 1 and 35."
  }
}

variable "preferred_backup_window" {
  description = "Optional backup window (UTC, hh24:mi-hh24:mi); null lets RDS choose."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Deletion protection (must stay true outside disposable test stacks)."
  type        = bool
  default     = true
}

variable "performance_insights_retention_days" {
  description = "Performance Insights retention (7 = AWS default tier). SQL digests can contain literals, so the data is KMS-encrypted."
  type        = number
  default     = 7
}

variable "log_retention_days" {
  description = "Retention of exported PostgreSQL logs. No default: set in the retention matrix."
  type        = number
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value."
  }
}

variable "logs_kms_key_arn" {
  description = "CMK for the exported PostgreSQL log group."
  type        = string
  nullable    = false
}

variable "database_name" {
  description = "Initial database name (opaque)."
  type        = string
  default     = "vsp"
}

variable "master_username" {
  description = "Master user name (password managed by RDS in Secrets Manager; break-glass only)."
  type        = string
  default     = "vsp_admin"
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
