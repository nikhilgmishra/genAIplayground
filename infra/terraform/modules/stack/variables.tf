# Inputs of the per-environment composition. Values that are decisions for named
# owners (retention, budgets, Object Lock, sizing) have NO defaults; environments
# leave them UNKNOWN in tfvars until the owner supplies them, so plan fails closed.

variable "environment" {
  description = "sandbox | staging | production."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["sandbox", "staging", "production"], var.environment)
    error_message = "environment must be sandbox, staging or production."
  }
}

variable "deployment_role" {
  description = "primary (the single write region) or dr (secondary US region, write-fenced unless a reviewed failover enables mutations)."
  type        = string
  default     = "primary"

  validation {
    condition     = contains(["primary", "dr"], var.deployment_role)
    error_message = "deployment_role must be primary or dr."
  }
}

variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI), unique per account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "workload_account_id" {
  description = "Workload account of this environment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "workload_account_id must be a 12-digit AWS account id."
  }
}

variable "audit_account_id" {
  description = "Separate audit account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.audit_account_id))
    error_message = "audit_account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  description = "Region of this stack (US only)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region."
  }
}

variable "audit_region" {
  description = "Region of the audit bucket in the audit account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.audit_region))
    error_message = "audit_region must be a US commercial region."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "availability_zones" {
  description = ">= 3 AZ names in the region."
  type        = list(string)
  nullable    = false
}

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  nullable    = false
}

variable "nat_gateway_per_az" {
  description = "One NAT gateway per AZ (true for staging/production)."
  type        = bool
  default     = true
}

variable "key_admin_role_arns" {
  description = "Administrator roles for KMS keys and secrets (the bootstrap administrator / break-glass role). The CI apply role of this stack is added automatically."
  type        = list(string)
  nullable    = false
}

variable "github_repository" {
  description = "owner/name of the repository allowed to federate into CI roles."
  type        = string
  nullable    = false
}

variable "ci" {
  description = "CI identity: manage = create the OIDC roles here; create_oidc_provider = false when another stack in the account owns the provider."
  type = object({
    manage               = bool
    create_oidc_provider = bool
    oidc_provider_arn    = optional(string)
    github_environment   = string
    allowed_regions      = list(string)
    state_bucket_arn     = string
    state_key_prefix     = string
    state_kms_key_arn    = optional(string)
  })
  nullable = false
}

variable "certificate_arn" {
  description = "ACM certificate for the approved Talkdesk-facing hostname (UNKNOWN until the hostname is approved)."
  type        = string
  nullable    = false
}

variable "ingress" {
  description = "Ingress options (see modules/ingress)."
  type = object({
    idle_timeout_seconds         = optional(number, 120)
    http_redirect_enabled        = optional(bool, false)
    supplemental_allowlist_cidrs = optional(list(string), [])
    waf_rate_limit_per_5min      = optional(number, 120000)
    jwt_validation = optional(object({
      issuer        = string
      jwks_endpoint = string
    }))
    elb_log_delivery_account_id = optional(string)
    deletion_protection         = optional(bool, true)
  })
  default = {}
}

variable "image" {
  description = "Signed image to run: digest from the release manifest; repository created here or shared."
  type = object({
    digest                = string
    create_ecr_repository = optional(bool, true)
    repository_url        = optional(string)
    repository_arn        = optional(string)
    cpu_architecture      = optional(string, "X86_64")
  })
  nullable = false
}

variable "service_sizing" {
  description = "Task sizing and warm capacity per service. No defaults: PLACEHOLDER values until SRE sizes from load tests (spec section 12)."
  type = map(object({
    cpu                 = number
    memory              = number
    min_capacity        = number
    max_capacity        = number
    requests_per_target = optional(number)
  }))
  nullable = false

  validation {
    condition     = contains(keys(var.service_sizing), "gateway") && contains(keys(var.service_sizing), "worker")
    error_message = "service_sizing must define gateway and worker."
  }
}

variable "service_commands" {
  description = "Container commands. The production entry points are an interface request to the platform engineers."
  type        = map(list(string))
  default = {
    gateway = ["node", "dist/main/server.js"]
    worker  = ["node", "dist/worker/main.js"]
  }
}

variable "aurora" {
  description = "Aurora settings. engine_version, instance_class and backup_retention_days have no defaults."
  type = object({
    engine_version            = string
    instance_class            = string
    instance_count            = optional(number, 2)
    backup_retention_days     = number
    cluster_role              = optional(string, "standalone")
    global_cluster_identifier = optional(string)
    deletion_protection       = optional(bool, true)
  })
  nullable = false
}

variable "sessions" {
  description = "Session table: create here (primary) or use the global-table replica created by the primary stack (dr). replica_region creates the DR replica and its regional CMK from the primary stack."
  type = object({
    create              = bool
    existing_table_name = optional(string)
    replica_region      = optional(string)
    dr_name_prefix      = optional(string)
    replica_kms_key_arn = optional(string)
    billing_mode        = optional(string, "PAY_PER_REQUEST")
  })
  nullable = false
}

variable "retention_days" {
  description = "Log/backup retention per class. NO DEFAULTS: security operations and privacy counsel set these in the retention matrix (spec section 6)."
  type = object({
    application_logs = number
    flow_logs        = number
    waf_logs         = number
    alb_access_logs  = number
    database_logs    = number
    workflow_logs    = number
    metrics_logs     = number
  })
  nullable = false
}

variable "audit" {
  description = "Audit evidence store. managed_here = false consumes an audit store administered separately (DR stack, or production when security applies the audit module itself)."
  type = object({
    managed_here                = bool
    object_lock_mode            = optional(string)
    object_lock_retention_days  = optional(number)
    auditor_principal_arns      = optional(list(string), [])
    key_admin_role_arns         = optional(list(string), [])
    legal_hold_role_arns        = optional(list(string), [])
    additional_writer_role_arns = optional(list(string), [])
    existing_bucket_name        = optional(string)
    existing_writer_role_arn    = optional(string)
  })
  nullable = false
}

variable "budget" {
  description = "AWS Budgets alert (one per account). monthly_limit_usd has no default: finance sets it."
  type = object({
    create            = bool
    monthly_limit_usd = optional(number)
  })
  nullable = false
}

variable "mutations_enabled" {
  description = "false = write fence (DR default). Enabling mutations in a DR region requires a reviewed failover change (spec section 12)."
  type        = bool
  nullable    = false
}

variable "failover_change_ref" {
  description = "Reference to the reviewed failover decision (change/incident record) that authorizes mutations in the DR region. null = fenced. External side effects must be reconciled before reopening mutations (spec section 12)."
  type        = string
  default     = null
}

variable "asl_dir" {
  description = "Directory with generated Step Functions ASL (infra/stepfunctions)."
  type        = string
  nullable    = false
}

variable "workflow_log_level" {
  description = "Step Functions log level (ERROR | ALL | FATAL); execution data is never included."
  type        = string
  default     = "ERROR"
}

variable "secret_rotation_hooks" {
  description = "Optional rotation Lambda ARNs and periods by secret key (owners provide them)."
  type = map(object({
    lambda_arn = string
    days       = number
  }))
  default = {}
}

variable "tags" {
  description = "Extra tags (no PHI)."
  type        = map(string)
  default     = {}
}
