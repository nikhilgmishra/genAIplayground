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

variable "region" {
  description = "AWS region (US only)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^us-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a US commercial region."
  }
}

variable "partition" {
  description = "AWS partition."
  type        = string
  default     = "aws"
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
  nullable    = false
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB (>= 3 AZs)."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.public_subnet_ids) >= 3
    error_message = "The ALB must span at least three availability zones."
  }
}

variable "certificate_arn" {
  description = "ACM certificate for the Talkdesk-facing hostname. UNKNOWN until the hostname is approved; supplied per environment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:us-[a-z]+-[0-9]:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN in a US region."
  }
}

variable "ssl_policy" {
  description = "ALB TLS negotiation policy. Restricted to TLS 1.3 / 1.2 (TLS13) policies."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"

  validation {
    condition     = can(regex("^ELBSecurityPolicy-TLS13-", var.ssl_policy))
    error_message = "ssl_policy must be an ELBSecurityPolicy-TLS13-* policy (no TLS 1.0/1.1)."
  }
}

variable "idle_timeout_seconds" {
  description = <<-EOT
    ALB idle timeout. MCP Streamable HTTP can hold a response stream (SSE) open; the
    timeout must exceed the longest permitted tool call and any server keep-alive interval.
    Talkdesk's client-side timeout and streaming behaviour are UNKNOWN (owner: Talkdesk
    administrator + platform engineering; next action: verify against the tenant and record
    in the release evidence). 120 s is a placeholder pending that verification.
  EOT
  type        = number
  default     = 120

  validation {
    condition     = var.idle_timeout_seconds >= 30 && var.idle_timeout_seconds <= 4000
    error_message = "idle_timeout_seconds must be between 30 and 4000."
  }
}

variable "http_redirect_enabled" {
  description = "Create an HTTP:80 listener that only redirects to HTTPS. Off by default: Talkdesk calls the HTTPS URL directly and every open port is surface. Enabling it opens 0.0.0.0/0:80 on the ALB, which the infrastructure policy only accepts for redirect-only listeners."
  type        = bool
  default     = false
}

variable "target_port" {
  description = "Gateway container port."
  type        = number
  default     = 8080
}

variable "target_protocol" {
  description = "ALB-to-task protocol inside the private subnets. HTTPS requires the gateway to terminate TLS (interface change request); HTTP is restricted by security groups to ALB -> task only."
  type        = string
  default     = "HTTP"

  validation {
    condition     = contains(["HTTP", "HTTPS"], var.target_protocol)
    error_message = "target_protocol must be HTTP or HTTPS."
  }
}

variable "health_check_path" {
  description = "Gateway readiness endpoint (must report not-ready when policy bundle, session store or audit sink are unavailable)."
  type        = string
  default     = "/health/ready"
}

variable "deregistration_delay_seconds" {
  description = "Connection draining for in-flight tool calls and open streams during deployments."
  type        = number
  default     = 60
}

variable "routes" {
  description = <<-EOT
    Path-based allowlist of what the public listener forwards. Everything else gets a fixed 404.
    require_jwt applies the ALB jwt-validation action when var.jwt_validation is configured
    (supplemental; the gateway's own transport authentication remains authoritative).
  EOT
  type = map(object({
    priority      = number
    path_patterns = list(string)
    require_jwt   = bool
  }))
  default = {
    mcp = {
      priority      = 10
      path_patterns = ["/mcp", "/mcp/*"]
      require_jwt   = true
    }
    telephony = {
      priority      = 20
      path_patterns = ["/telephony/*"]
      require_jwt   = true
    }
    portal = {
      priority      = 30
      path_patterns = ["/portal/*"]
      require_jwt   = false
    }
  }

  validation {
    condition     = alltrue([for r in values(var.routes) : alltrue([for p in r.path_patterns : !contains(["/*", "*", "/"], p)])])
    error_message = "Routes must be specific path patterns; a catch-all route would expose every gateway endpoint."
  }
}

variable "jwt_validation" {
  description = "Optional ALB JWT validation for service-to-service routes. Issuer and JWKS endpoint of the authorization server that issues Talkdesk's OAuth2 client-credential tokens: UNKNOWN until that authorization server is chosen (null = disabled)."
  type = object({
    issuer        = string
    jwks_endpoint = string
  })
  default = null
}

variable "waf_rate_limit_per_5min" {
  description = <<-EOT
    WAF rate-based rule limit per source IP per 5-minute window. ILLUSTRATIVE default derived
    from the spec section 12 illustrative load floor (400 tool requests/s sustained x 300 s),
    which assumes Talkdesk traffic may arrive from a single egress IP. Real value requires the
    Talkdesk egress IP inventory and measured traffic (owner: SRE; next action: load test).
  EOT
  type        = number
  default     = 120000

  validation {
    condition     = var.waf_rate_limit_per_5min >= 100 && var.waf_rate_limit_per_5min <= 2000000000
    error_message = "waf_rate_limit_per_5min must be between 100 and 2,000,000,000."
  }
}

variable "supplemental_allowlist_cidrs" {
  description = "Optional source IP allowlist enforced by WAF. Supplemental only (spec section 3): IP allowlists are never authentication. Talkdesk egress ranges are UNKNOWN; empty = no allowlist rule."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.supplemental_allowlist_cidrs : can(cidrhost(c, 0)) && !contains(["0.0.0.0/0"], c)])
    error_message = "supplemental_allowlist_cidrs must be valid IPv4 CIDRs and must not be 0.0.0.0/0."
  }
}

variable "waf_managed_rule_groups" {
  description = "AWS managed rule groups (vendor AWS) in evaluation order. AWSManagedRulesAnonymousIpList is not included by default because its hosting-provider list can match cloud-hosted contact-centre egress; evaluate in COUNT first."
  type        = list(string)
  default     = ["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet"]

  validation {
    condition     = contains(var.waf_managed_rule_groups, "AWSManagedRulesCommonRuleSet") && contains(var.waf_managed_rule_groups, "AWSManagedRulesKnownBadInputsRuleSet")
    error_message = "The common and known-bad-inputs managed rule groups are mandatory."
  }
}

variable "logs_kms_key_arn" {
  description = "CMK for the WAF log group."
  type        = string
  nullable    = false
}

variable "waf_log_retention_days" {
  description = "WAF log retention. No default: set by security operations in the retention matrix."
  type        = number
  nullable    = false

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.waf_log_retention_days)
    error_message = "waf_log_retention_days must be a CloudWatch Logs retention value."
  }
}

variable "access_log_expiration_days" {
  description = "ALB access-log object expiration. No default: set by security operations in the retention matrix."
  type        = number
  nullable    = false

  validation {
    condition     = var.access_log_expiration_days >= 1
    error_message = "access_log_expiration_days must be >= 1."
  }
}

variable "elb_log_delivery_account_id" {
  description = "Regional Elastic Load Balancing account for access-log delivery in regions that predate the logdelivery.elasticloadbalancing.amazonaws.com service principal. null = use the service principal. Verify per region against the current ALB access-log documentation (UNKNOWN until checked)."
  type        = string
  default     = null

  validation {
    condition     = var.elb_log_delivery_account_id == null || can(regex("^[0-9]{12}$", var.elb_log_delivery_account_id))
    error_message = "elb_log_delivery_account_id must be null or a 12-digit account id."
  }
}

variable "deletion_protection" {
  description = "ALB deletion protection."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
