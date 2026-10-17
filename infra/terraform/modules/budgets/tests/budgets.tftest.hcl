# [OPS-05] [SPEC-12.cost] Budget alerts exist, require a finance-supplied limit
# (null rejected) and are documented as not being hard caps.
# Offline: mock provider, plan only. The limit below is a SYNTHETIC test input.

mock_provider "aws" {}

variables {
  name_prefix       = "vsp-test"
  monthly_limit_usd = 1
  alarm_topic_arn   = "arn:aws:sns:us-east-1:111111111111:vsp-test-alarms"
}

run "alerts_not_caps" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.budget_type == "COST" && aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "monthly cost budget"
  }

  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 4
    error_message = "actual thresholds plus a forecasted 100 percent alert"
  }

  assert {
    condition     = output.is_hard_cap == false
    error_message = "[OPS-05] budgets are alerts, not hard caps"
  }
}

run "rejects_missing_limit" {
  command = plan

  variables {
    monthly_limit_usd = null
  }

  expect_failures = [var.monthly_limit_usd]
}
