# [SPEC-3.ingress] Only the Talkdesk ingress is exposed: HTTPS-only with a TLS 1.3/1.2
# policy, WAF managed rules + rate limit, path allowlist with fixed 404, access logs,
# credential and bearer-header redaction in WAF logs (VSP-INF-01). Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix                = "vsp-test"
  account_id                 = "111111111111"
  region                     = "us-east-1"
  vpc_id                     = "vpc-0123456789abcdef0"
  public_subnet_ids          = ["subnet-0000000000000000a", "subnet-0000000000000000b", "subnet-0000000000000000c"]
  certificate_arn            = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  logs_kms_key_arn           = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
  waf_log_retention_days     = 30
  access_log_expiration_days = 30
}

run "https_only_with_waf" {
  command = plan

  assert {
    condition     = aws_lb_listener.https.protocol == "HTTPS" && can(regex("^ELBSecurityPolicy-TLS13-", aws_lb_listener.https.ssl_policy))
    error_message = "[SPEC-3.ingress] HTTPS listener with a TLS13 policy"
  }

  assert {
    condition     = length(aws_lb_listener.http_redirect) == 0 && length(aws_vpc_security_group_ingress_rule.alb_http_redirect) == 0
    error_message = "no port 80 exposure by default"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_https.from_port == 443 && aws_vpc_security_group_ingress_rule.alb_https.to_port == 443
    error_message = "the only internet ingress is 443"
  }

  assert {
    condition     = aws_lb.this.drop_invalid_header_fields == true && aws_lb.this.desync_mitigation_mode == "strictest" && aws_lb.this.enable_waf_fail_open == false
    error_message = "ALB hardening: drop invalid headers, strictest desync mitigation, WAF fail closed"
  }

  assert {
    condition     = aws_lb.this.idle_timeout == 120
    error_message = "idle timeout placeholder is explicit (UNKNOWN until verified with Talkdesk)"
  }

  assert {
    condition     = aws_lb.this.access_logs[0].enabled == true
    error_message = "ALB access logs enabled"
  }

  assert {
    condition     = aws_lb_listener.https.default_action[0].type == "fixed-response" && aws_lb_listener.https.default_action[0].fixed_response[0].status_code == "404"
    error_message = "unmatched paths get a fixed 404, never the gateway"
  }

  assert {
    condition     = length([for r in local.waf_rules : r if try(r.Statement.RateBasedStatement.Limit, 0) == 120000]) == 1
    error_message = "rate-based rule present with the illustrative limit"
  }

  assert {
    condition = alltrue([for g in ["AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet", "AWSManagedRulesAmazonIpReputationList"] :
    length([for r in local.waf_rules : r if try(r.Statement.ManagedRuleGroupStatement.Name, "") == g]) == 1])
    error_message = "AWS managed rule groups attached"
  }

  assert {
    condition     = alltrue([for r in local.waf_rules : r.VisibilityConfig.SampledRequestsEnabled == false])
    error_message = "[AUTH-06] sampled requests (which retain headers) are disabled"
  }

  assert {
    condition     = length(aws_wafv2_web_acl_logging_configuration.this.redacted_fields) == 7
    error_message = "[AUTH-06] exactly the six credential/bearer headers and the query string are redacted from WAF logs"
  }

  assert {
    condition = alltrue([for h in ["authorization", "cookie", "mcp-session-id", "x-vsp-session-ref", "x-vsp-interaction-id", "idempotency-key"] :
      contains([for f in aws_wafv2_web_acl_logging_configuration.this.redacted_fields : f.single_header[0].name if length(f.single_header) > 0], h)
    ])
    error_message = "[AUTH-06][VSP-INF-01] WAF logs redact Authorization, Cookie, Mcp-Session-Id, the bearer X-VSP-Session-Ref, X-VSP-Interaction-Id and Idempotency-Key by name"
  }

  assert {
    condition     = length([for f in aws_wafv2_web_acl_logging_configuration.this.redacted_fields : f if length(f.query_string) > 0]) == 1
    error_message = "[AUTH-06][VSP-INF-01] the query string is redacted from WAF logs"
  }

  assert {
    condition     = alltrue([for f in aws_wafv2_web_acl_logging_configuration.this.redacted_fields : f.single_header[0].name == lower(f.single_header[0].name) if length(f.single_header) > 0])
    error_message = "[VSP-INF-01] WAF single_header redactions must be lowercase (WAF matches lowercase names)"
  }

  assert {
    condition     = length(aws_wafv2_web_acl_logging_configuration.this.logging_filter) == 0
    error_message = "[OPS-03][VSP-INF-01] every request is logged (no logging_filter), which is why the bearer headers above must be redacted"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.access_logs.block_public_acls && aws_s3_bucket_public_access_block.access_logs.restrict_public_buckets
    error_message = "access-log bucket blocks public access"
  }

  assert {
    condition     = aws_cloudwatch_log_group.waf.kms_key_id == var.logs_kms_key_arn
    error_message = "WAF logs are KMS encrypted"
  }

  assert {
    condition     = length(aws_wafv2_ip_set.allowlist) == 0
    error_message = "no allowlist unless configured (Talkdesk egress ranges UNKNOWN)"
  }
}

run "jwt_and_allowlist_are_supplemental_options" {
  command = plan

  variables {
    supplemental_allowlist_cidrs = ["198.51.100.0/24"]
    jwt_validation = {
      issuer        = "https://issuer.example.invalid"
      jwks_endpoint = "https://issuer.example.invalid/.well-known/jwks.json"
    }
  }

  assert {
    condition     = length(aws_wafv2_ip_set.allowlist) == 1
    error_message = "allowlist ip set created when configured"
  }

  assert {
    condition     = length(aws_lb_listener_rule.route["mcp"].action) == 2 && length(aws_lb_listener_rule.route["portal"].action) == 1
    error_message = "JWT validation only on service-to-service routes"
  }
}

run "redirect_listener_only_redirects" {
  command = plan

  variables {
    http_redirect_enabled = true
  }

  assert {
    condition     = aws_lb_listener.http_redirect[0].default_action[0].type == "redirect" && aws_lb_listener.http_redirect[0].default_action[0].redirect[0].protocol == "HTTPS"
    error_message = "HTTP listener, when enabled, only redirects to HTTPS"
  }
}

run "rejects_legacy_tls_policy" {
  command = plan

  variables {
    ssl_policy = "ELBSecurityPolicy-2016-08"
  }

  expect_failures = [var.ssl_policy]
}

run "rejects_catch_all_route" {
  command = plan

  variables {
    routes = {
      all = { priority = 1, path_patterns = ["/*"], require_jwt = false }
    }
  }

  expect_failures = [var.routes]
}

run "rejects_open_allowlist" {
  command = plan

  variables {
    supplemental_allowlist_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.supplemental_allowlist_cidrs]
}
