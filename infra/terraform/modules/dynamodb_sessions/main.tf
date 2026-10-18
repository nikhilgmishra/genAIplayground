# Trusted call-session store (spec sections 3 and 7). The application performs every
# write with a ConditionExpression (compare-and-swap on "version"); DynamoDB TTL on
# attribute "ttl" is cleanup only, so readers enforce expiry themselves (AUTH-04).
#
# Global-table replicas: conditional writes are evaluated against the local replica
# only and cross-region conflicts resolve last-writer-wins. That is why the platform
# has ONE write region and the DR stack is write-fenced (IAM deny) until a reviewed
# failover. Multi-region strong consistency is not assumed.

variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "kms_key_arn" {
  description = "CMK for the table (TRANSIENT_CONVERSATION data class)."
  type        = string
  nullable    = false
}

variable "billing_mode" {
  description = "PAY_PER_REQUEST or PROVISIONED."
  type        = string
  default     = "PAY_PER_REQUEST"

  validation {
    condition     = contains(["PAY_PER_REQUEST", "PROVISIONED"], var.billing_mode)
    error_message = "billing_mode must be PAY_PER_REQUEST or PROVISIONED."
  }
}

variable "read_capacity" {
  description = "Provisioned read capacity (PROVISIONED only; from load tests)."
  type        = number
  default     = null
}

variable "write_capacity" {
  description = "Provisioned write capacity (PROVISIONED only; from load tests)."
  type        = number
  default     = null
}

variable "on_demand_max_request_units" {
  description = "Optional ceiling on on-demand read/write request units (cost guard; not a hard budget cap). null = no table-level ceiling."
  type = object({
    read  = number
    write = number
  })
  default = null
}

variable "replicas" {
  description = "Global-table replicas (DR region). Each needs a CMK in its own region."
  type = list(object({
    region_name = string
    kms_key_arn = string
  }))
  default = []

  validation {
    condition     = alltrue([for r in var.replicas : can(regex("^us-[a-z]+-[0-9]$", r.region_name))])
    error_message = "Replicas must be in US regions."
  }
}

variable "deletion_protection" {
  description = "Deletion protection."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}

locals {
  has_replicas = length(var.replicas) > 0
}

resource "terraform_data" "capacity_guard" {
  input = var.billing_mode

  lifecycle {
    precondition {
      condition     = var.billing_mode == "PAY_PER_REQUEST" || (var.read_capacity != null && var.write_capacity != null)
      error_message = "PROVISIONED billing requires read_capacity and write_capacity."
    }
  }
}

resource "aws_dynamodb_table" "sessions" {
  name         = "${var.name_prefix}-sessions"
  billing_mode = var.billing_mode
  hash_key     = "pk"

  read_capacity  = var.billing_mode == "PROVISIONED" ? var.read_capacity : null
  write_capacity = var.billing_mode == "PROVISIONED" ? var.write_capacity : null

  table_class                 = "STANDARD"
  deletion_protection_enabled = var.deletion_protection

  # Streams are required for global-table replication only.
  stream_enabled   = local.has_replicas
  stream_view_type = local.has_replicas ? "NEW_AND_OLD_IMAGES" : null

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  dynamic "on_demand_throughput" {
    for_each = var.on_demand_max_request_units == null || var.billing_mode != "PAY_PER_REQUEST" ? [] : [var.on_demand_max_request_units]
    content {
      max_read_request_units  = on_demand_throughput.value.read
      max_write_request_units = on_demand_throughput.value.write
    }
  }

  dynamic "replica" {
    for_each = var.replicas
    content {
      region_name                 = replica.value.region_name
      kms_key_arn                 = replica.value.kms_key_arn
      point_in_time_recovery      = true
      propagate_tags              = true
      deletion_protection_enabled = var.deletion_protection
      consistency_mode            = "EVENTUAL"
    }
  }

  tags = merge(var.tags, { "vsp:data-class" = "TRANSIENT_CONVERSATION" })
}

output "table_name" {
  description = "Session table name."
  value       = aws_dynamodb_table.sessions.name
}

output "table_arn" {
  description = "Session table ARN."
  value       = aws_dynamodb_table.sessions.arn
}
