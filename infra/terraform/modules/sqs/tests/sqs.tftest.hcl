# [SPEC-3.sqs] [ACT-02] Every queue has a DLQ with redrive, KMS, TLS-only policy and a
# DLQ depth > 0 alarm; FIFO where ordering matters. Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix     = "vsp-test"
  account_id      = "111111111111"
  kms_key_arn     = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000006"
  alarm_topic_arn = "arn:aws:sns:us-east-1:111111111111:vsp-test-alarms"
  queues = {
    crm-sync = {
      fifo                       = true
      visibility_timeout_seconds = 120
      max_receive_count          = 5
      outbox_topics              = ["support_request.sync"]
    }
    notifications = {
      fifo                       = false
      visibility_timeout_seconds = 60
      max_receive_count          = 5
      outbox_topics              = ["notification.send"]
    }
  }
}

run "queues_have_dlq_kms_and_alarms" {
  command = plan

  assert {
    condition     = length(aws_sqs_queue.dlq) == length(aws_sqs_queue.this)
    error_message = "[SPEC-3.sqs] every queue has a dead-letter queue"
  }

  assert {
    condition     = alltrue([for q in values(aws_sqs_queue.this) : q.kms_master_key_id == var.kms_key_arn])
    error_message = "[SPEC-6.encryption] queues use the CMK, not SQS-managed keys"
  }

  assert {
    condition     = alltrue([for q in values(aws_sqs_queue.dlq) : q.kms_master_key_id == var.kms_key_arn])
    error_message = "DLQs are KMS encrypted too"
  }

  assert {
    condition     = aws_sqs_queue.this["crm-sync"].fifo_queue == true && endswith(aws_sqs_queue.this["crm-sync"].name, ".fifo") && endswith(aws_sqs_queue.dlq["crm-sync"].name, "-dlq.fifo")
    error_message = "FIFO queue and FIFO DLQ for ordered CRM sync"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.dlq_depth) : a.threshold == 0 && a.comparison_operator == "GreaterThanThreshold"])
    error_message = "[SPEC-13.alerts] alarm on DLQ depth > 0"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.dlq_depth) : !can(regex("[0-9]{3}-[0-9]{4}|@|DOB|ssn", a.alarm_description))])
    error_message = "[DATA-01] alarm text carries no PHI"
  }

  assert {
    condition     = output.topic_routes["support_request.sync"] == "crm-sync"
    error_message = "outbox topic routing is published for the live publisher"
  }
}

run "rejects_unbounded_redelivery" {
  command = plan

  variables {
    queues = {
      bad = {
        fifo                       = false
        visibility_timeout_seconds = 30
        max_receive_count          = 0
        outbox_topics              = []
      }
    }
  }

  expect_failures = [var.queues]
}
