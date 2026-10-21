# [SPEC-3.ingress] Only the Talkdesk ingress is exposed: HTTPS-only with a TLS 1.3/1.2
# policy, WAF managed rules + rate limit, path allowlist with fixed 404, access logs,
# credential and bearer-header redaction in WAF logs (VSP-INF-01). The edge rate limit
# never blocks the tool-caller paths that carry the safety and human routes (SAFE-02,
# SAFE-03): it is enforced elsewhere and only counted there. Offline: mock provider, plan only.

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
    condition     = length([for r in local.waf_rules : r if try(r.Statement.RateBasedStatement.Limit, 0) == 120000]) == 2
    error_message = "rate-based rules (enforced and observed) present with the illustrative limit"
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

# [SAFE-02][SAFE-03][SPEC-12.rate-limit] The edge rate limit is fail-safe for the safety and human
# routes: WAF cannot tell request_safety_route / request_human_transfer / utterance screening /
# human request / handoff apart from other Talkdesk calls on /mcp and /telephony/, so the BLOCK
# rule is scoped to every other path and the same limit is only COUNTED on those (ADR-0012).
run "edge_rate_limit_never_blocks_safety_route_paths" {
  command = plan

  assert {
    condition     = length([for r in local.waf_rules : r if can(r.Statement.RateBasedStatement) && can(r.Action.Block)]) == 1 && length([for r in local.waf_rules : r if can(r.Statement.RateBasedStatement) && can(r.Action.Count)]) == 1
    error_message = "[SAFE-03] exactly one blocking and one count-only per-IP rate rule"
  }

  assert {
    condition = alltrue([for r in local.waf_rules : r.Statement.RateBasedStatement.ScopeDownStatement == { NotStatement = { Statement = local.tool_caller_paths } }
    if can(r.Statement.RateBasedStatement) && can(r.Action.Block)])
    error_message = "[SAFE-02][SAFE-03] the blocking rate rule applies only outside the tool-caller paths"
  }

  assert {
    condition = alltrue([for r in local.waf_rules : r.Statement.RateBasedStatement.ScopeDownStatement == local.tool_caller_paths && r.VisibilityConfig.MetricName == output.waf_rate_observe_metric_name
    if can(r.Statement.RateBasedStatement) && can(r.Action.Count)])
    error_message = "[SAFE-03] the tool-caller paths are counted (alarmed metric), never blocked"
  }

  assert {
    condition     = local.tool_caller_paths.RegexMatchStatement.FieldToMatch == { UriPath = {} } && local.tool_caller_paths.RegexMatchStatement.TextTransformations == [{ Priority = 0, Type = "NONE" }]
    error_message = "the tool-caller match reads the URI path as received (no transformation widens the exemption)"
  }

  assert {
    condition     = length(regexall("\\((?:[^?]|$)", local.tool_caller_path_regex)) == 0
    error_message = "the tool-caller regex uses non-capturing groups only (AWS WAF's regex syntax excludes capturing subexpressions)"
  }

  # Every path the default mcp and telephony routes forward, including each safety and human-route
  # operation, is exempt from blocking; the portal, a near miss and a mis-cased path are not.
  assert {
    condition = alltrue([for p in ["/mcp", "/mcp/", "/mcp/messages", "/telephony/v1/session/utterance-screening", "/telephony/v1/session/human-request", "/telephony/v1/session/handoff", "/telephony/v1/calls"] :
    can(regex(local.tool_caller_path_regex, p))])
    error_message = "[SAFE-02][SAFE-03] every safety and human-route path is a tool-caller path"
  }

  assert {
    condition = alltrue([for p in ["/portal/v1/verification/approve", "/mcpx", "/MCP", "/Telephony/v1/session/handoff", "/v1/tools/request_safety_route/1.0.0", "/health/ready", "/"] :
    !can(regex(local.tool_caller_path_regex, p))])
    error_message = "the exemption covers the tool-caller paths only; everything else keeps the blocking limit"
  }

  assert {
    condition = alltrue([for p in concat(var.routes["mcp"].path_patterns, var.routes["telephony"].path_patterns) :
    can(regex(local.tool_caller_path_regex, replace(p, "*", "x")))])
    error_message = "the exemption matches what the default mcp and telephony listener rules forward"
  }

  assert {
    condition     = output.web_acl_name == "vsp-test-ingress" && output.waf_rate_observe_metric_name == "vsp-test-rate-observe-tool-paths"
    error_message = "the web ACL and count-only rule metric names are exported for the observability alarm"
  }
}

run "edge_rate_limit_with_supplemental_allowlist" {
  command = plan

  variables {
    supplemental_allowlist_cidrs = ["198.51.100.0/24"]
  }

  assert {
    condition     = local.waf_rules[0].Name == "supplemental-source-allowlist" && local.waf_rules[0].Priority == 0 && can(local.waf_rules[0].Action.Block)
    error_message = "with an allowlist, every other source is blocked before any rate rule"
  }

  assert {
    condition     = length([for r in local.waf_rules : r if can(r.Statement.RateBasedStatement) && can(r.Action.Block) && r.Statement.RateBasedStatement.ScopeDownStatement == { NotStatement = { Statement = local.tool_caller_paths } }]) == 1
    error_message = "[SAFE-03] the allowlisted vendor egress is never rate-blocked on the tool-caller paths"
  }
}

# [SAFE-02][SAFE-03] A new Talkdesk-facing (service-to-service) route outside the tool-caller paths is
# refused at plan time instead of silently falling under the blocking per-IP limit (for example a
# transfer-events webhook, if one is ever routed).
run "rejects_service_route_outside_tool_caller_paths" {
  command = plan

  variables {
    routes = {
      mcp       = { priority = 10, path_patterns = ["/mcp", "/mcp/*"], require_jwt = true }
      telephony = { priority = 20, path_patterns = ["/telephony/*"], require_jwt = true }
      portal    = { priority = 30, path_patterns = ["/portal/*"], require_jwt = false }
      webhooks  = { priority = 40, path_patterns = ["/v1/webhooks/*"], require_jwt = true }
    }
  }

  expect_failures = [aws_wafv2_web_acl.this]
}

run "rejects_service_route_widening_a_tool_caller_prefix" {
  command = plan

  variables {
    routes = {
      mcp       = { priority = 10, path_patterns = ["/mcp*"], require_jwt = true }
      telephony = { priority = 20, path_patterns = ["/telephony/*"], require_jwt = true }
    }
  }

  expect_failures = [aws_wafv2_web_acl.this]
}

run "portal_style_route_keeps_the_blocking_limit" {
  command = plan

  variables {
    routes = {
      mcp       = { priority = 10, path_patterns = ["/mcp", "/mcp/*"], require_jwt = true }
      telephony = { priority = 20, path_patterns = ["/telephony/*"], require_jwt = true }
      portal    = { priority = 30, path_patterns = ["/portal/*"], require_jwt = false }
      status    = { priority = 40, path_patterns = ["/status/*"], require_jwt = false }
    }
  }

  assert {
    condition     = length(aws_lb_listener_rule.route) == 4
    error_message = "routes that Talkdesk does not call may stay outside the tool-caller paths"
  }
}
