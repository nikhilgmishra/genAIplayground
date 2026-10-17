# SYNTHETIC (production offline policy plan). See offline-common.tfvars.
audit_deploy_role_arn            = "arn:aws:iam::222222222222:role/vsp-audit-deployer"
audit_key_admin_role_arns        = ["arn:aws:iam::222222222222:role/vsp-audit-admin"]
certificate_arn                  = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
ci_state                         = { bucket_arn = "arn:aws:s3:::vsp-tfstate-111111111111", key_prefix = "envs/production/" }
audit_object_lock_mode           = "GOVERNANCE"
audit_object_lock_retention_days = 1
monthly_budget_usd               = 1
