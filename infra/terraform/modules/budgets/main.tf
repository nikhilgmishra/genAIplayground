# AWS Budgets alerts per environment account (spec section 12, OPS-05).
# IMPORTANT: AWS Budgets notifications are ALERTS, NOT HARD CAPS. Cost data is
# metered with delay, fixed and committed charges continue, and nothing here stops
# spend. Spend control is: (1) no billable execution without a scoped approval,
# (2) application admission limits and kill switches, (3) vendor contract controls.
# Budget exhaustion must never disconnect an active safety handoff. AWS Budgets
# covers AWS charges only; Talkdesk, Salesforce, model and speech vendor charges are
# tracked by the platform's cost metrics and contracts.

variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "monthly_limit_usd" {
  description = "Approved monthly AWS budget for this environment. REQUIRED with no default: finance sets it (owner: finance and platform owner). The coding agent does not choose budgets or prices."
  type        = number

  validation {
    condition     = var.monthly_limit_usd != null && coalesce(var.monthly_limit_usd, 0) > 0
    error_message = "monthly_limit_usd must be set by finance (> 0); null is rejected."
  }
}

variable "alert_thresholds_percent" {
  description = "Percent-of-budget thresholds that notify (actual and forecasted)."
  type        = list(number)
  default     = [50, 80, 100]

  validation {
    condition     = length(var.alert_thresholds_percent) > 0 && alltrue([for t in var.alert_thresholds_percent : t > 0 && t <= 200])
    error_message = "alert_thresholds_percent must be non-empty values in (0, 200]."
  }
}

variable "alarm_topic_arn" {
  description = "KMS-encrypted SNS topic (key policy admits budgets.amazonaws.com)."
  type        = string
  nullable    = false
}

variable "cost_filter_tag" {
  description = "Optional cost-allocation tag filter as key=value (tag must be activated in Billing). null = whole account (one account per environment)."
  type        = string
  default     = null
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly-aws"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = var.cost_filter_tag == null ? [] : [var.cost_filter_tag]
    content {
      name   = "TagKeyValue"
      values = ["user:${replace(cost_filter.value, "=", "$")}"]
    }
  }

  dynamic "notification" {
    for_each = toset([for t in var.alert_thresholds_percent : tostring(t)])
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = tonumber(notification.value)
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [var.alarm_topic_arn]
    }
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [var.alarm_topic_arn]
  }
}

output "budget_name" {
  description = "Budget name."
  value       = aws_budgets_budget.monthly.name
}

output "is_hard_cap" {
  description = "Always false: AWS Budgets alerts do not stop spend."
  value       = false
}
