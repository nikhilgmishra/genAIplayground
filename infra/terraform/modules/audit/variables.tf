variable "name_prefix" {
  description = "Opaque resource name prefix (no PHI)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must be 3-25 chars of lowercase letters, digits and hyphens."
  }
}

variable "audit_account_id" {
  description = "The independently administered AUDIT account that owns every resource in this module."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.audit_account_id))
    error_message = "audit_account_id must be a 12-digit AWS account id."
  }
}

variable "workload_account_id" {
  description = "The workload account whose task roles ship evidence (must differ from the audit account)."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "workload_account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  description = "AWS region of the audit bucket (US only)."
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

variable "object_lock_mode" {
  description = "S3 Object Lock default retention mode (GOVERNANCE or COMPLIANCE). REQUIRED with no default: privacy counsel and security leadership must choose it (spec sections 6 and 13). COMPLIANCE cannot be shortened or removed by anyone, including the root user."
  type        = string

  validation {
    condition     = var.object_lock_mode != null && contains(["GOVERNANCE", "COMPLIANCE"], coalesce(var.object_lock_mode, "UNSET"))
    error_message = "object_lock_mode must be set to GOVERNANCE or COMPLIANCE by counsel/security; null is rejected."
  }
}

variable "object_lock_retention_days" {
  description = "S3 Object Lock default retention in days for SECURITY_AUDIT evidence. REQUIRED with no default: the retention matrix owner (privacy counsel + security) sets it. The coding agent does not choose a retention duration."
  type        = number

  validation {
    condition     = var.object_lock_retention_days != null && coalesce(var.object_lock_retention_days, 0) >= 1 && coalesce(var.object_lock_retention_days, 0) <= 36500
    error_message = "object_lock_retention_days must be set (1-36500) by counsel/security; null is rejected."
  }
}

variable "writer_principal_arns" {
  description = "Workload-account task role ARNs allowed to assume the write-only audit writer role (gateway and worker shippers)."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.writer_principal_arns) > 0 && alltrue([for a in var.writer_principal_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "writer_principal_arns must be a non-empty list of IAM role ARNs."
  }
}

variable "auditor_principal_arns" {
  description = "Audit-account principals (e.g. the workforce SSO auditor role) allowed to assume the read-only auditor role. Empty = auditor role not created yet (BLOCKED on the identity owner)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.auditor_principal_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "auditor_principal_arns must be IAM role ARNs."
  }
}

variable "key_admin_role_arns" {
  description = "Audit-account roles that administer the audit CMK and bucket configuration (cannot read evidence)."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.key_admin_role_arns) > 0
    error_message = "At least one audit-account administrator role is required."
  }
}

variable "legal_hold_role_arns" {
  description = "Audit-account roles allowed to place or release legal holds. Empty = nobody can."
  type        = list(string)
  default     = []
}

variable "evidence_prefix" {
  description = "Object key prefix the writer may put to."
  type        = string
  default     = "audit/"

  validation {
    condition     = can(regex("^[a-z0-9-]+/$", var.evidence_prefix))
    error_message = "evidence_prefix must be a short lowercase prefix ending in /."
  }
}

variable "tags" {
  description = "Tags applied to every resource (no PHI)."
  type        = map(string)
  default     = {}
}
