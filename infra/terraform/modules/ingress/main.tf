# Talkdesk-facing ingress (spec section 3): the only internet-exposed surface.
# HTTPS-only ALB with a TLS 1.3/1.2 policy, path allowlist with a fixed 404 default,
# WAFv2 (AWS managed rule groups + rate-based rules, optional supplemental source
# allowlist), access logs to a dedicated bucket, WAF logs with credentials redacted.
# Authentication of the caller and of Talkdesk remains in the gateway.
#
# Rate limiting at the edge is fail-safe for the safety and human routes (SAFE-02,
# SAFE-03, ADR-0012): the per-source-IP rate rule BLOCKs only requests OUTSIDE the
# tool-caller paths (/mcp, /telephony/). Those paths carry request_safety_route,
# request_human_transfer, utterance screening, the human request and the handoff, and
# their only legitimate caller is Talkdesk, whose traffic for every concurrent call can
# share one egress IP. WAF cannot tell a safety call from any other call on them, and
# a per-IP block there would cut off safety and human transfers together with
# everything else. On those paths the same limit is COUNTED (CloudWatch metric
# `<prefix>-rate-observe-tool-paths`, alarmed by the observability module) and never
# blocks; every request on them is still authenticated by the gateway, and every
# non-safety tool call is metered per call and per integration there (ADR-0012).
# With supplemental_allowlist_cidrs set, every other source is blocked outright.

locals {
  alb_name        = "${var.name_prefix}-ingress"
  log_bucket_name = "${var.name_prefix}-alb-logs-${var.account_id}"
  log_prefix      = "alb"
  waf_log_group   = "aws-waf-logs-${var.name_prefix}"

  log_delivery_principal = var.elb_log_delivery_account_id == null ? { Service = "logdelivery.elasticloadbalancing.amazonaws.com" } : { AWS = "arn:${var.partition}:iam::${var.elb_log_delivery_account_id}:root" }

  visibility = { SampledRequestsEnabled = false, CloudWatchMetricsEnabled = true }

  allowlist_rules = length(var.supplemental_allowlist_cidrs) == 0 ? [] : [{
    Name     = "supplemental-source-allowlist"
    Priority = 0
    Action   = { Block = {} }
    Statement = {
      NotStatement = {
        Statement = { IPSetReferenceStatement = { ARN = aws_wafv2_ip_set.allowlist[0].arn } }
      }
    }
    VisibilityConfig = merge(local.visibility, { MetricName = "${var.name_prefix}-allowlist" })
  }]

  # The tool-caller paths of the default routes (mcp, telephony; see the header comment): "/mcp",
  # "/mcp/..." and "/telephony/...". Case-sensitive match on the URI path as received (no
  # transformation): a mis-cased or encoded variant is a non-tool path and gets the blocking limit,
  # never the exemption (ALB path patterns are case-sensitive too, so a mis-cased variant gets the
  # fixed 404; how the ALB treats a percent-encoded path is not verified offline). A regex string,
  # not a ByteMatch, because ByteMatch search strings are binary blobs in the WAF API. Non-capturing
  # groups only: AWS WAF's regex syntax excludes capturing subexpressions, and RE2 (Terraform, OPA)
  # reads (?:...) the same way.
  tool_caller_path_regex = "^/(?:mcp(?:/|$)|telephony/)"
  tool_caller_paths = {
    RegexMatchStatement = {
      RegexString         = local.tool_caller_path_regex
      FieldToMatch        = { UriPath = {} }
      TextTransformations = [{ Priority = 0, Type = "NONE" }]
    }
  }

  rate_limit_metric_name   = "${var.name_prefix}-rate-limit"
  rate_observe_metric_name = "${var.name_prefix}-rate-observe-tool-paths"

  rate_rules = [
    {
      Name     = "rate-limit-per-source-ip"
      Priority = 1
      Action   = { Block = {} }
      Statement = {
        RateBasedStatement = {
          Limit               = var.waf_rate_limit_per_5min
          AggregateKeyType    = "IP"
          EvaluationWindowSec = 300
          ScopeDownStatement  = { NotStatement = { Statement = local.tool_caller_paths } }
        }
      }
      VisibilityConfig = merge(local.visibility, { MetricName = local.rate_limit_metric_name })
    },
    {
      # Never blocks: safety and human-route calls share these paths (SAFE-02, SAFE-03).
      Name     = "rate-observe-tool-caller-paths"
      Priority = 2
      Action   = { Count = {} }
      Statement = {
        RateBasedStatement = {
          Limit               = var.waf_rate_limit_per_5min
          AggregateKeyType    = "IP"
          EvaluationWindowSec = 300
          ScopeDownStatement  = local.tool_caller_paths
        }
      }
      VisibilityConfig = merge(local.visibility, { MetricName = local.rate_observe_metric_name })
    },
  ]

  managed_rules = [for i, g in var.waf_managed_rule_groups : {
    Name             = g
    Priority         = 10 + i
    OverrideAction   = { None = {} }
    Statement        = { ManagedRuleGroupStatement = { VendorName = "AWS", Name = g } }
    VisibilityConfig = merge(local.visibility, { MetricName = "${var.name_prefix}-${lower(g)}" })
  }]

  waf_rules = concat(local.allowlist_rules, local.rate_rules, local.managed_rules)

  jwt_enabled = var.jwt_validation != null
}

# ---------------------------------------------------------------- access logs
resource "aws_s3_bucket" "access_logs" {
  bucket        = local.log_bucket_name
  force_destroy = false

  tags = merge(var.tags, {
    "vsp:data-class"           = "OPERATIONAL_TELEMETRY"
    "vsp:encryption-exception" = "alb-access-logs-require-sse-s3"
  })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ALB access-log delivery supports only SSE-S3 (Amazon S3 managed keys), not SSE-KMS.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {
      prefix = "${local.log_prefix}/"
    }
    expiration {
      days = var.access_log_expiration_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AlbAccessLogDelivery"
        Effect    = "Allow"
        Principal = local.log_delivery_principal
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.access_logs.arn}/${local.log_prefix}/AWSLogs/${var.account_id}/*"
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

# ---------------------------------------------------------------- load balancer
resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Public ALB: HTTPS from the internet only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb", "vsp:exposure" = "public-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from Talkdesk (internet); WAF and gateway authentication apply"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"

  tags = merge(var.tags, { "vsp:exposure" = "public-alb-https" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  count = var.http_redirect_enabled ? 1 : 0

  security_group_id = aws_security_group.alb.id
  description       = "HTTP for redirect-to-HTTPS only"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"

  tags = merge(var.tags, { "vsp:exposure" = "public-alb-http-redirect" })
}

resource "aws_lb" "this" {
  name               = local.alb_name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  ip_address_type    = "ipv4"

  idle_timeout               = var.idle_timeout_seconds
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_http2               = true
  enable_waf_fail_open       = false
  enable_deletion_protection = var.deletion_protection
  xff_header_processing_mode = "append"
  preserve_host_header       = false

  access_logs {
    bucket  = aws_s3_bucket.access_logs.id
    prefix  = local.log_prefix
    enabled = true
  }

  tags = merge(var.tags, { "vsp:exposure" = "public-alb" })

  depends_on = [aws_s3_bucket_policy.access_logs]
}

resource "aws_lb_target_group" "gateway" {
  name                          = "${var.name_prefix}-gateway"
  target_type                   = "ip"
  vpc_id                        = var.vpc_id
  port                          = var.target_port
  protocol                      = var.target_protocol
  protocol_version              = "HTTP1"
  deregistration_delay          = var.deregistration_delay_seconds
  load_balancing_algorithm_type = "least_outstanding_requests"

  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = var.target_protocol
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  stickiness {
    type    = "lb_cookie"
    enabled = false
  }

  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  routing_http_response_server_enabled                         = false
  routing_http_response_strict_transport_security_header_value = "max-age=31536000; includeSubDomains"
  routing_http_response_x_content_type_options_header_value    = "nosniff"
  routing_http_response_x_frame_options_header_value           = "DENY"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"not_found\"}"
      status_code  = "404"
    }
  }

  tags = var.tags
}

resource "aws_lb_listener_rule" "route" {
  for_each = var.routes

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  dynamic "action" {
    for_each = local.jwt_enabled && each.value.require_jwt ? [1] : []
    content {
      type  = "jwt-validation"
      order = 1
      jwt_validation {
        issuer        = var.jwt_validation.issuer
        jwks_endpoint = var.jwt_validation.jwks_endpoint
      }
    }
  }

  action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  condition {
    path_pattern {
      values = each.value.path_patterns
    }
  }

  tags = var.tags
}

resource "aws_lb_listener" "http_redirect" {
  count = var.http_redirect_enabled ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------- WAF
resource "aws_wafv2_ip_set" "allowlist" {
  count = length(var.supplemental_allowlist_cidrs) == 0 ? 0 : 1

  name               = "${var.name_prefix}-supplemental-allowlist"
  description        = "Supplemental source allowlist (not authentication)"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.supplemental_allowlist_cidrs

  tags = var.tags
}

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name_prefix}-ingress"
  description = "Talkdesk ingress protections"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule_json = jsonencode(local.waf_rules)

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-ingress"
    sampled_requests_enabled   = false
  }

  tags = var.tags

  lifecycle {
    # SAFE-02, SAFE-03: a service-to-service route (require_jwt: Talkdesk is its caller) outside the
    # tool-caller paths would fall under the per-IP BLOCK rule, which cannot tell its safety or
    # handoff traffic apart from the rest of Talkdesk's shared egress. Each pattern is checked through
    # one sample path ("*" and "?" as "x"); that is exact here, because "x" occurs in neither
    # "/mcp/" nor "/telephony/", so a sample can only match when the pattern's literal prefix does.
    precondition {
      condition = alltrue(flatten([for r in values(var.routes) : [for p in r.path_patterns :
      can(regex(local.tool_caller_path_regex, replace(replace(p, "*", "x"), "?", "x")))] if r.require_jwt]))
      error_message = "Every service-to-service (require_jwt) route must be a tool-caller path (/mcp, /mcp/..., /telephony/...); otherwise the per-IP rate rule can block Talkdesk's safety and handoff calls on it. Extend tool_caller_path_regex and the WAF-RATE probe paths together."
    }
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  name                        = local.waf_log_group
  retention_in_days           = var.waf_log_retention_days
  kms_key_id                  = var.logs_kms_key_arn
  deletion_protection_enabled = true

  tags = merge(var.tags, { "vsp:data-class" = "OPERATIONAL_TELEMETRY" })
}

resource "aws_cloudwatch_log_resource_policy" "waf" {
  policy_name = "${var.name_prefix}-waf-log-delivery"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "WafLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "delivery.logs.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = ["${aws_cloudwatch_log_group.waf.arn}:*"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${var.partition}:logs:${var.region}:${var.account_id}:*" }
      }
    }]
  })
}

# WAF logs record every request header (no logging_filter: allowed requests are logged
# too), so every header that carries a credential, a bearer reference or a caller-chosen
# token is redacted by name; WAF writes REDACTED in place of the value (VSP-INF-01):
#  - authorization, cookie: integration credentials;
#  - mcp-session-id: MCP transport session;
#  - x-vsp-session-ref: the opaque session reference, a bearer for the live call
#    (platform/src/gateway/session-binding.ts SESSION_REF_HEADER; sent on every Studio
#    telephony-control step and on MCP requests in trusted_header mode);
#  - x-vsp-interaction-id: the Talkdesk call id that binds a session to the call (and
#    resolves it in server_to_server_lookup mode);
#  - idempotency-key: model- or client-chosen key of a consequential request.
# The query string is redacted as well (one-time tokens must never be in URLs, but a
# misbehaving client could still put one there). Header names must be lowercase.
locals {
  waf_redacted_headers = ["authorization", "cookie", "mcp-session-id", "x-vsp-session-ref", "x-vsp-interaction-id", "idempotency-key"]
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  dynamic "redacted_fields" {
    for_each = local.waf_redacted_headers
    content {
      single_header {
        name = redacted_fields.value
      }
    }
  }
  redacted_fields {
    query_string {}
  }

  depends_on = [aws_cloudwatch_log_resource_policy.waf]
}
