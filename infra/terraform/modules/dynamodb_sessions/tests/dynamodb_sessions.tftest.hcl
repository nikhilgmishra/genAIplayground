# [SPEC-3.sessions] [AUTH-04] Session table: PITR, CMK SSE, TTL attribute "ttl",
# deletion protection, optional global-table replica. Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix = "vsp-test"
  kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000004"
}

run "session_table_controls" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.sessions.point_in_time_recovery[0].enabled == true
    error_message = "[SPEC-3.sessions] point-in-time recovery enabled"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.server_side_encryption[0].enabled && aws_dynamodb_table.sessions.server_side_encryption[0].kms_key_arn == var.kms_key_arn
    error_message = "[SPEC-6.encryption] SSE with the customer-managed key"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.ttl[0].attribute_name == "ttl" && aws_dynamodb_table.sessions.ttl[0].enabled
    error_message = "[AUTH-04] TTL attribute is ttl (cleanup only; readers enforce expiry)"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.deletion_protection_enabled == true
    error_message = "deletion protection on"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.sessions.hash_key == "pk"
    error_message = "on-demand by default, keyed by opaque pk"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.stream_enabled == false
    error_message = "no stream unless replicated"
  }
}

run "dr_replica" {
  command = plan

  variables {
    replicas = [{ region_name = "us-west-2", kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-000000000005" }]
  }

  assert {
    condition     = length(aws_dynamodb_table.sessions.replica) == 1 && one(aws_dynamodb_table.sessions.replica).point_in_time_recovery == true
    error_message = "[SPEC-12.recovery] replica has PITR and its own regional CMK"
  }

  assert {
    condition     = aws_dynamodb_table.sessions.stream_enabled == true && aws_dynamodb_table.sessions.stream_view_type == "NEW_AND_OLD_IMAGES"
    error_message = "streams enabled for global-table replication"
  }
}

run "rejects_non_us_replica" {
  command = plan

  variables {
    replicas = [{ region_name = "eu-west-1", kms_key_arn = "arn:aws:kms:eu-west-1:111111111111:key/x" }]
  }

  expect_failures = [var.replicas]
}
