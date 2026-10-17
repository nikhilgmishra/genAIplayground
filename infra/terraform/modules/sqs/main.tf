# Event delivery queues (spec sections 3 and 8): at-least-once delivery from the
# transactional outbox; consumers deduplicate. Every queue has a dead-letter queue
# with redrive, KMS encryption, TLS-only access and a DLQ-depth > 0 alarm.
# FIFO is used where per-aggregate ordering matters (MessageGroupId = aggregate key).
# Messages carry opaque references only; PHI stays in access-controlled tables.

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

variable "kms_key_arn" {
  description = "CMK for queue encryption (DELIVERY_METADATA)."
  type        = string
  nullable    = false
}

variable "queues" {
  description = "Queues keyed by short name. max_receive_count bounds redelivery before the DLQ."
  type = map(object({
    fifo                        = bool
    visibility_timeout_seconds  = number
    max_receive_count           = number
    content_based_deduplication = optional(bool, false)
    high_throughput_fifo        = optional(bool, false)
    outbox_topics               = list(string)
  }))
  nullable = false

  validation {
    condition     = alltrue([for k, _ in var.queues : can(regex("^[a-z][a-z0-9-]{1,30}$", k))])
    error_message = "Queue keys must be short lowercase identifiers."
  }

  validation {
    condition     = alltrue([for q in values(var.queues) : q.max_receive_count >= 1 && q.max_receive_count <= 50])
    error_message = "max_receive_count must be between 1 and 50."
  }
}

variable "dlq_message_retention_seconds" {
  description = "DLQ message retention. Default is the SQS maximum (14 days) so operators can repair; DLQ messages are opaque references, not records. Confirm in the retention matrix."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_message_retention_seconds >= 60 && var.dlq_message_retention_seconds <= 1209600
    error_message = "dlq_message_retention_seconds must be between 60 and 1209600."
  }
}

variable "alarm_topic_arn" {
  description = "SNS topic for DLQ alarms."
  type        = string
  nullable    = false
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}

locals {
  suffix = { for k, q in var.queues : k => q.fifo ? ".fifo" : "" }
}

resource "aws_sqs_queue" "dlq" {
  for_each = var.queues

  name                              = "${var.name_prefix}-${each.key}-dlq${local.suffix[each.key]}"
  fifo_queue                        = each.value.fifo ? true : null
  message_retention_seconds         = var.dlq_message_retention_seconds
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300

  tags = merge(var.tags, { "vsp:queue-role" = "dlq", "vsp:data-class" = "DELIVERY_METADATA" })
}

resource "aws_sqs_queue" "this" {
  for_each = var.queues

  name                              = "${var.name_prefix}-${each.key}${local.suffix[each.key]}"
  fifo_queue                        = each.value.fifo ? true : null
  content_based_deduplication       = each.value.fifo ? each.value.content_based_deduplication : null
  deduplication_scope               = each.value.fifo && each.value.high_throughput_fifo ? "messageGroup" : null
  fifo_throughput_limit             = each.value.fifo && each.value.high_throughput_fifo ? "perMessageGroupId" : null
  visibility_timeout_seconds        = each.value.visibility_timeout_seconds
  receive_wait_time_seconds         = 20
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })

  tags = merge(var.tags, {
    "vsp:queue-role"    = "primary"
    "vsp:data-class"    = "DELIVERY_METADATA"
    "vsp:outbox-topics" = join(" ", each.value.outbox_topics)
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = var.queues

  queue_url = aws_sqs_queue.dlq[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this[each.key].arn]
  })
}

resource "aws_sqs_queue_policy" "this" {
  for_each = merge(
    { for k, q in aws_sqs_queue.this : k => q },
    { for k, q in aws_sqs_queue.dlq : "${k}-dlq" => q },
  )

  queue_url = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = each.value.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyPrincipalsOutsideAccount"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = each.value.arn
        Condition = { StringNotEquals = { "aws:PrincipalAccount" = var.account_id } }
      },
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each = var.queues

  alarm_name          = "${var.name_prefix}-${each.key}-dlq-depth"
  alarm_description   = "Dead-letter messages present for queue ${each.key}. Runbook RB-DLQ-REPAIR. Messages hold opaque references; repair through the console reconciliation flow."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq[each.key].name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  tags = var.tags
}

output "queue_arns" {
  description = "Primary queue ARNs by key."
  value       = { for k, q in aws_sqs_queue.this : k => q.arn }
}

output "queue_urls" {
  description = "Primary queue URLs by key."
  value       = { for k, q in aws_sqs_queue.this : k => q.id }
}

output "dlq_arns" {
  description = "Dead-letter queue ARNs by key."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.arn }
}

output "queue_names" {
  description = "Primary queue names by key."
  value       = { for k, q in aws_sqs_queue.this : k => q.name }
}

output "topic_routes" {
  description = "Outbox topic -> queue key routing (MessagePublisher live-adapter contract)."
  value       = merge([for k, q in var.queues : { for t in q.outbox_topics : t => k }]...)
}
