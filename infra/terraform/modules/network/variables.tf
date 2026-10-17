variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "account_id" {
  description = "Workload AWS account id (used in endpoint and flow-log policies)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "trusted_account_ids" {
  description = "Additional accounts whose principals may use the S3/DynamoDB gateway endpoints (the audit account, so the shipper's assumed audit-writer role can write evidence)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.trusted_account_ids : can(regex("^[0-9]{12}$", a))])
    error_message = "trusted_account_ids must be 12-digit AWS account ids."
  }
}

variable "region" {
  description = "AWS region (US only)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region such as us-east-1."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "vpc_cidr" {
  description = "VPC IPv4 CIDR (/16 to /20)."
  type        = string
  nullable    = false

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid IPv4 CIDR between /16 and /20."
  }
}

variable "availability_zones" {
  description = "Availability zone names. Spec section 3 requires at least three where available."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.availability_zones) >= 3 && length(distinct(var.availability_zones)) == length(var.availability_zones)
    error_message = "At least three distinct availability zones are required (spec section 3)."
  }
}

variable "nat_gateway_per_az" {
  description = "true = one NAT gateway per AZ (AZ-independent egress); false = a single NAT gateway (cheaper, single-AZ egress dependency; non-production only)."
  type        = bool
  default     = true
}

variable "interface_endpoint_services" {
  description = "Interface VPC endpoint service short names. Stateful services and AWS APIs are reached privately."
  type        = list(string)
  default     = ["sqs", "kms", "secretsmanager", "logs", "monitoring", "ecr.api", "ecr.dkr", "sts", "states"]

  validation {
    condition = alltrue([for s in ["sqs", "kms", "secretsmanager", "logs", "ecr.api", "ecr.dkr", "sts", "states"] :
    contains(var.interface_endpoint_services, s)])
    error_message = "interface_endpoint_services must include at least sqs, kms, secretsmanager, logs, ecr.api, ecr.dkr, sts and states."
  }
}

variable "flow_log_retention_days" {
  description = "VPC flow log retention in days. No default: security operations sets it in the retention matrix (spec section 6). Must be a CloudWatch Logs supported value."
  type        = number
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.flow_log_retention_days)
    error_message = "flow_log_retention_days must be a CloudWatch Logs retention value (0/never-expire is not allowed)."
  }
}

variable "logs_kms_key_arn" {
  description = "CMK for the flow log group."
  type        = string
  nullable    = false
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary attached to every IAM role created by this module (null only outside CI-managed accounts)."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
