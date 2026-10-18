terraform {
  required_version = ">= 1.16.4, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.67.0, < 7.0.0"
      # Every resource in this module is created with the AUDIT ACCOUNT provider.
      # There is deliberately no default-provider resource here.
      configuration_aliases = [aws.audit]
    }
  }
}
