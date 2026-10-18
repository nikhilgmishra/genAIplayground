# [SPEC-3.workflows] [SPEC-9.workflows] STANDARD state machines rendered from generated
# ASL via templatefile; logs never include execution data; CMK encryption.
# Offline: mock provider, plan only. The ASL used here is a SYNTHETIC fixture.

mock_provider "aws" {}

variables {
  name_prefix              = "vsp-test"
  account_id               = "111111111111"
  region                   = "us-east-1"
  definitions_dir          = "./tests/fixtures"
  definition_substitutions = { workflow_events_queue_url = "https://sqs.us-east-1.amazonaws.com/111111111111/vsp-test-workflow-events.fifo" }
  kms_key_arn              = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000007"
  logs_kms_key_arn         = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
  log_retention_days       = 30
  send_queue_arns          = ["arn:aws:sqs:us-east-1:111111111111:vsp-test-workflow-events.fifo"]
  queue_kms_key_arn        = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000006"
}

run "standard_machines_without_execution_data_in_logs" {
  command = plan

  assert {
    condition     = length(aws_sfn_state_machine.this) == 1 && aws_sfn_state_machine.this["sample-review"].type == "STANDARD"
    error_message = "[SPEC-3.workflows] one STANDARD state machine per ASL file"
  }

  assert {
    condition     = alltrue([for m in aws_sfn_state_machine.this : m.logging_configuration[0].include_execution_data == false])
    error_message = "[DATA-01] include_execution_data = false so execution payloads never enter logs"
  }

  assert {
    condition     = alltrue([for m in aws_sfn_state_machine.this : m.logging_configuration[0].level == "ERROR"])
    error_message = "logging level defaults to ERROR"
  }

  assert {
    condition     = alltrue([for m in aws_sfn_state_machine.this : m.encryption_configuration[0].type == "CUSTOMER_MANAGED_KMS_KEY"])
    error_message = "[SPEC-6.encryption] state machines encrypted with the CMK"
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.this["sample-review"].definition).States.NotifyWorker.Parameters.QueueUrl == "https://sqs.us-east-1.amazonaws.com/111111111111/vsp-test-workflow-events.fifo"
    error_message = "placeholders are substituted with resource identifiers"
  }

  assert {
    condition     = aws_sfn_state_machine.this["sample-review"].name == "vsp-test-sample-review"
    error_message = "state machine names are derived from workflow type, never from case data"
  }

  assert {
    condition     = length(aws_sfn_alias.live) == 1 && alltrue([for m in aws_sfn_state_machine.this : m.publish])
    error_message = "[SPEC-15.release] versions are published and starts go through the live alias (in-flight executions keep their version)"
  }

  assert {
    condition     = aws_cloudwatch_log_group.executions.kms_key_id == var.logs_kms_key_arn
    error_message = "execution log group is KMS encrypted"
  }
}

run "missing_definitions_dir_is_empty_not_an_error" {
  command = plan

  variables {
    definitions_dir = "./tests/does-not-exist"
  }

  assert {
    condition     = length(aws_sfn_state_machine.this) == 0
    error_message = "no ASL files yet = no state machines (validation still passes)"
  }
}

run "rejects_logging_off" {
  command = plan

  variables {
    log_level = "OFF"
  }

  expect_failures = [var.log_level]
}
