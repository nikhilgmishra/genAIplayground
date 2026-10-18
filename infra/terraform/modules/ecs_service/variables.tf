variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "environment" {
  description = "Deployment environment label passed to the containers (VSP_ENVIRONMENT)."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["sandbox", "staging", "production"], var.environment)
    error_message = "environment must be sandbox, staging or production (the DR stack is production in its secondary region)."
  }
}

variable "account_id" {
  description = "Workload AWS account id."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  description = "AWS region (US only)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
  nullable    = false
}

variable "app_subnet_ids" {
  description = "Private application subnets (>= 3 AZs). Tasks never receive public IPs."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.app_subnet_ids) >= 3
    error_message = "Services must span at least three availability zones."
  }
}

variable "endpoint_security_group_id" {
  description = "Security group of the interface VPC endpoints."
  type        = string
  nullable    = false
}

variable "s3_prefix_list_id" {
  description = "S3 gateway endpoint prefix list."
  type        = string
  nullable    = false
}

variable "dynamodb_prefix_list_id" {
  description = "DynamoDB gateway endpoint prefix list."
  type        = string
  nullable    = false
}

variable "create_ecr_repository" {
  description = "Create an immutable, KMS-encrypted ECR repository in this account. false = use image_repository_url/arn from a shared artifact account."
  type        = bool
  default     = true
}

variable "image_repository_url" {
  description = "Existing repository URL when create_ecr_repository = false."
  type        = string
  default     = null
}

variable "image_repository_arn" {
  description = "Existing repository ARN when create_ecr_repository = false."
  type        = string
  default     = null
}

variable "image_digest" {
  description = "Signed, scanned image digest from the release manifest. Tasks run by digest only, never by tag."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "image_digest must be a sha256 digest (sha256:<64 hex>); tags are not deployable."
  }
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture; must match the built image."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "services" {
  description = <<-EOT
    Fargate services. task_role_policy_json is the least-privilege identity policy for the
    service's own task role (built by the environment from concrete resource ARNs).
    secret_arns maps environment variable names to Secrets Manager secret ARNs (values are
    never in Terraform). min_capacity is the minimum warm capacity kept by autoscaling.
  EOT
  type = map(object({
    command                     = list(string)
    cpu                         = number
    memory                      = number
    min_capacity                = number
    max_capacity                = number
    container_port              = optional(number)
    attach_to_load_balancer     = bool
    cpu_target_percent          = optional(number, 60)
    requests_per_target         = optional(number)
    environment                 = map(string)
    secret_arns                 = map(string)
    task_role_policy_json       = string
    allow_internet_egress_https = bool
    health_check_command        = list(string)
  }))
  nullable = false

  validation {
    condition     = alltrue([for k, _ in var.services : can(regex("^[a-z][a-z0-9-]{1,15}$", k))])
    error_message = "Service names must be short lowercase identifiers."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : s.min_capacity >= 1 && s.max_capacity >= s.min_capacity])
    error_message = "Every service keeps at least one warm task and max_capacity >= min_capacity."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : can(jsondecode(s.task_role_policy_json).Statement)])
    error_message = "task_role_policy_json must be a JSON IAM policy document."
  }

  validation {
    condition     = length([for s in values(var.services) : s if s.attach_to_load_balancer]) <= 1
    error_message = "Only one service (the gateway) attaches to the public load balancer."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : !s.attach_to_load_balancer || s.container_port != null])
    error_message = "A load-balanced service needs container_port."
  }

  validation {
    condition = alltrue([for s in values(var.services) : alltrue([for k in keys(s.environment) :
    !contains(["VSP_ENVIRONMENT", "VSP_MUTATIONS_ENABLED", "NODE_ENV"], k)])])
    error_message = "VSP_ENVIRONMENT, VSP_MUTATIONS_ENABLED and NODE_ENV are set by the module and cannot be overridden."
  }
}

variable "target_group_arn" {
  description = "Gateway target group (ingress module)."
  type        = string
  default     = null
}

variable "target_group_arn_suffix" {
  description = "Gateway target group ARN suffix for request-count autoscaling."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix for request-count autoscaling."
  type        = string
  default     = null
}

variable "alb_security_group_id" {
  description = "ALB security group; this module adds the ALB -> gateway egress/ingress pair."
  type        = string
  default     = null
}

variable "write_fence" {
  description = <<-EOT
    Regional write fence (spec section 12). mutations_enabled = false sets
    VSP_MUTATIONS_ENABLED=false in every container AND attaches an explicit IAM Deny on
    writes to the listed tables, queues and state machines, so a secondary region cannot
    accept mutations even if application configuration is wrong.
  EOT
  type = object({
    mutations_enabled            = bool
    protected_table_arns         = list(string)
    protected_queue_arns         = list(string)
    protected_state_machine_arns = list(string)
  })
  nullable = false
}

variable "log_retention_days" {
  description = "Application log retention. No default: set by security operations in the retention matrix."
  type        = number
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value."
  }
}

variable "logs_kms_key_arn" {
  description = "CMK for application log groups."
  type        = string
  nullable    = false
}

variable "ecr_kms_key_arn" {
  description = "CMK for the ECR repository (when created here)."
  type        = string
  default     = null
}

variable "secrets_kms_key_arn" {
  description = "CMK protecting the Secrets Manager secrets the tasks read."
  type        = string
  nullable    = false
}

variable "ephemeral_storage_kms_key_arn" {
  description = "Optional CMK for Fargate ephemeral storage (key policy must admit fargate.amazonaws.com for this cluster)."
  type        = string
  default     = null
}

variable "container_insights" {
  description = "ECS Container Insights setting (enabled | enhanced | disabled)."
  type        = string
  default     = "enabled"

  validation {
    condition     = contains(["enabled", "enhanced", "disabled"], var.container_insights)
    error_message = "container_insights must be enabled, enhanced or disabled."
  }
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary attached to every IAM role created here."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
