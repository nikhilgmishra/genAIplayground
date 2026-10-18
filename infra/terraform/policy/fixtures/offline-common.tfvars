# SYNTHETIC values for the offline (fake-credential, no-AWS) policy plans run by
# scripts/terraform-plan-offline.sh. Fictional accounts 111111111111 (workload) and
# 222222222222 (audit). Retention / Object Lock / budget numbers are placeholders that
# only exercise the code paths: they are NOT retention, budget or legal decisions.
workload_account_id          = "111111111111"
audit_account_id             = "222222222222"
key_admin_role_arns          = ["arn:aws:iam::111111111111:role/vsp-bootstrap-admin"]
image_digest                 = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
aurora_backup_retention_days = 1
retention_days = {
  application_logs = 1
  flow_logs        = 1
  waf_logs         = 1
  alb_access_logs  = 1
  database_logs    = 1
  workflow_logs    = 1
  metrics_logs     = 1
}
