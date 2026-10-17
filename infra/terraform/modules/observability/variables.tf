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

variable "metrics_namespace" {
  description = <<-EOT
    CloudWatch namespace of the platform's OpenTelemetry metrics (catalogue:
    platform/src/observability/metrics.ts). Export contract (BLOCKED until the collector
    configuration is approved): metric names unchanged, label keys become dimensions,
    and a zero-dimension aggregate is published for each metric (e.g. the ADOT awsemf
    exporter's ZeroAndSingleDimensionRollup). Until then application alarms report
    INSUFFICIENT_DATA, which is not a pass.
  EOT
  type        = string
  default     = "VSP"
}

variable "messaging_kms_key_arn" {
  description = "CMK for the alarm SNS topic (key policy must admit cloudwatch_alarms and budgets)."
  type        = string
  nullable    = false
}

variable "logs_kms_key_arn" {
  description = "CMK for the metrics/EMF log group."
  type        = string
  nullable    = false
}

variable "log_retention_days" {
  description = "Retention of the metrics (EMF) log group. No default: set in the retention matrix."
  type        = number
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value."
  }
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix (AWS/ApplicationELB dimension)."
  type        = string
  nullable    = false
}

variable "target_group_arn_suffix" {
  description = "Gateway target group ARN suffix."
  type        = string
  nullable    = false
}

variable "ecs_cluster_name" {
  description = "ECS cluster name."
  type        = string
  nullable    = false
}

variable "ecs_service_names" {
  description = "ECS service names by key."
  type        = map(string)
  nullable    = false
}

variable "aurora_cluster_identifier" {
  description = "Aurora cluster identifier."
  type        = string
  nullable    = false
}

variable "sessions_table_name" {
  description = "Session table name."
  type        = string
  nullable    = false
}

variable "queue_names" {
  description = "Primary SQS queue names by key."
  type        = map(string)
  nullable    = false
}

variable "tool_p95_threshold_ms" {
  description = "Tool-backed substantive response P95 alarm threshold. Default = PROPOSED spec section 13 target (3 s), not a measured capability."
  type        = number
  default     = 3000
}

variable "safety_route_threshold_ms" {
  description = "Safety route initiation alarm threshold. Default = spec section 10 engineering target (2 s from validated safety event)."
  type        = number
  default     = 2000
}

variable "crm_sync_threshold_ms" {
  description = "CRM synchronization alarm threshold at p99.9. Default = PROPOSED spec section 13 target (99.9 percent within 60 s)."
  type        = number
  default     = 60000
}

variable "http_5xx_rate_percent" {
  description = "ALB 5xx rate alarm threshold in percent. ENGINEERING PROPOSAL pending SRE review."
  type        = number
  default     = 1
}

variable "budget_burn_ratio" {
  description = "Projected spend / budget ratio that alarms. ENGINEERING PROPOSAL pending finance review; alarms are not caps."
  type        = number
  default     = 0.8
}

variable "admission_rejection_threshold" {
  description = "Admission rejections per 5 minutes that alarm (0 = any rejection notifies). ENGINEERING PROPOSAL."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
