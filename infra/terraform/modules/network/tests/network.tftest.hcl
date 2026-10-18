# [SPEC-3.network] >= 3 AZs, stateful tiers private, AWS APIs via VPC endpoints,
# KMS-encrypted flow logs. Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix             = "vsp-test"
  account_id              = "111111111111"
  trusted_account_ids     = ["222222222222"]
  region                  = "us-east-1"
  vpc_cidr                = "10.40.0.0/16"
  availability_zones      = ["us-east-1a", "us-east-1b", "us-east-1c"]
  flow_log_retention_days = 30
  logs_kms_key_arn        = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
}

run "three_az_private_layout" {
  command = plan

  assert {
    condition     = length(aws_subnet.app) == 3 && length(aws_subnet.data) == 3 && length(aws_subnet.public) == 3
    error_message = "[SPEC-3.network] one subnet per tier per AZ across three AZs"
  }

  assert {
    condition     = alltrue([for s in concat(values(aws_subnet.app), values(aws_subnet.data), values(aws_subnet.public)) : s.map_public_ip_on_launch == false])
    error_message = "no subnet auto-assigns public IPs"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 3
    error_message = "one NAT gateway per AZ by default"
  }

  assert {
    condition     = length(aws_route_table_association.data) == 3 && length(aws_route.app_nat) == 3
    error_message = "data subnets use the isolated route table; app subnets route through NAT"
  }

  assert {
    condition = alltrue([for s in ["sqs", "kms", "secretsmanager", "logs", "ecr.api", "ecr.dkr", "sts", "states"] :
    contains(keys(aws_vpc_endpoint.interface), s)])
    error_message = "[SPEC-3.network] interface endpoints for SQS, KMS, Secrets Manager, Logs, ECR, STS and Step Functions"
  }

  assert {
    condition     = contains(keys(aws_vpc_endpoint.gateway), "s3") && contains(keys(aws_vpc_endpoint.gateway), "dynamodb")
    error_message = "gateway endpoints for S3 and DynamoDB"
  }

  assert {
    condition     = jsondecode(aws_vpc_endpoint.gateway["s3"].policy).Statement[0].Condition.StringEquals["aws:PrincipalAccount"] == ["111111111111", "222222222222"]
    error_message = "endpoint policies admit only the workload and audit accounts"
  }

  assert {
    condition     = aws_cloudwatch_log_group.flow_logs.kms_key_id == var.logs_kms_key_arn && aws_cloudwatch_log_group.flow_logs.retention_in_days == 30
    error_message = "[SPEC-6.logs] flow logs are KMS encrypted with explicit retention"
  }

  assert {
    condition     = aws_flow_log.this.traffic_type == "ALL"
    error_message = "flow logs capture all traffic"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.endpoints_https.cidr_ipv4 == "10.40.0.0/16"
    error_message = "endpoint ingress is VPC-internal only"
  }

  assert {
    condition     = !can(regex("[0-9]{3}-[0-9]{3}-[0-9]{4}|@", aws_cloudwatch_log_group.flow_logs.name))
    error_message = "[DATA-01] log group names carry no PHI-like content"
  }
}

run "single_nat_for_non_production" {
  command = plan

  variables {
    nat_gateway_per_az = false
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 1 && length(aws_route.app_nat) == 3
    error_message = "single NAT mode still routes every app subnet"
  }
}

run "rejects_two_azs" {
  command = plan

  variables {
    availability_zones = ["us-east-1a", "us-east-1b"]
  }

  expect_failures = [var.availability_zones]
}

run "rejects_non_us_region" {
  command = plan

  variables {
    region = "eu-west-1"
  }

  expect_failures = [var.region]
}

run "rejects_unbounded_log_retention" {
  command = plan

  variables {
    flow_log_retention_days = 0
  }

  expect_failures = [var.flow_log_retention_days]
}
