# SYNTHETIC (production-dr offline policy plan). See offline-common.tfvars.
certificate_arn              = "arn:aws:acm:us-west-2:111111111111:certificate/00000000-0000-0000-0000-000000000000"
ci_state                     = { bucket_arn = "arn:aws:s3:::vsp-tfstate-111111111111", key_prefix = "envs/production-dr/" }
sessions_replica_kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-0000000000dd"
audit_bucket_name            = "vsp-production-audit-222222222222"
audit_writer_role_arn        = "arn:aws:iam::222222222222:role/vsp-production-audit-writer"
