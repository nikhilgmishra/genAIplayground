terraform {
  required_version = ">= 1.16.4, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # Partially configured: bucket, key, region and kms_key_id are supplied at init with
  # -backend-config=backend.hcl (see backend.hcl.example). Offline validation and tests
  # run with `terraform init -backend=false`. The state bucket is a bootstrap
  # prerequisite owned by the platform owner (versioned, SSE-KMS, public access blocked).
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}
