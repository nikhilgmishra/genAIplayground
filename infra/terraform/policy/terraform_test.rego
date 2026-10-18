# Unit tests for the infrastructure policy (opa test infra/terraform/policy).
# Fixtures are minimal SYNTHETIC `terraform show -json` fragments.
package vsp.terraform_test

import data.vsp.terraform

rc(type, address, module, after) := {
	"type": type,
	"address": address,
	"module_address": module,
	"change": {"actions": ["create"], "after": after, "after_unknown": {}},
}

rc_unknown(type, address, module, after, unknown) := {
	"type": type,
	"address": address,
	"module_address": module,
	"change": {"actions": ["create"], "after": after, "after_unknown": unknown},
}

plan(resources) := {"resource_changes": resources}

has_prefix(set, prefix) if {
	some m in set
	startswith(m, prefix)
}

# ------------------------------------------------------------ compliant baseline

good_bucket := rc("aws_s3_bucket", "module.a.aws_s3_bucket.b", "module.a", {"bucket": "vsp-test-b", "tags": {}})

good_pab := rc("aws_s3_bucket_public_access_block", "module.a.aws_s3_bucket_public_access_block.b", "module.a", {
	"block_public_acls": true, "block_public_policy": true, "ignore_public_acls": true, "restrict_public_buckets": true,
})

kms_sse := rc("aws_s3_bucket_server_side_encryption_configuration", "module.a.sse", "module.a", {"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "aws:kms"}]}]})

test_compliant_bucket_passes if {
	count(terraform.deny) == 0 with input as plan([good_bucket, good_pab, kms_sse])
}

# [SPEC-14.policy] no public S3
test_bucket_without_public_access_block_denied if {
	has_prefix(terraform.deny, "S3-PUBLIC") with input as plan([good_bucket, kms_sse])
}

test_partial_public_access_block_denied if {
	weak := rc("aws_s3_bucket_public_access_block", "module.a.pab", "module.a", {
		"block_public_acls": true, "block_public_policy": false, "ignore_public_acls": true, "restrict_public_buckets": true,
	})
	has_prefix(terraform.deny, "S3-PUBLIC") with input as plan([good_bucket, weak, kms_sse])
}

test_public_acl_denied if {
	acl := rc("aws_s3_bucket_acl", "module.a.acl", "module.a", {"acl": "public-read"})
	has_prefix(terraform.deny, "S3-PUBLIC") with input as plan([good_bucket, good_pab, kms_sse, acl])
}

test_public_bucket_policy_denied if {
	pol := rc("aws_s3_bucket_policy", "module.a.pol", "module.a", {"policy": json.marshal({"Statement": [{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "*"}]})})
	has_prefix(terraform.deny, "S3-PUBLIC") with input as plan([good_bucket, good_pab, kms_sse, pol])
}

# [SPEC-6.encryption] encryption everywhere
test_bucket_without_encryption_denied if {
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([good_bucket, good_pab])
}

test_sse_s3_without_exception_denied if {
	aes := rc("aws_s3_bucket_server_side_encryption_configuration", "module.a.sse", "module.a", {"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "AES256"}]}]})
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([good_bucket, good_pab, aes])
}

test_sse_s3_with_service_exception_allowed if {
	logs := rc("aws_s3_bucket", "module.a.aws_s3_bucket.logs", "module.a", {"bucket": "vsp-test-logs", "tags": {"vsp:encryption-exception": "alb-access-logs-require-sse-s3"}})
	aes := rc("aws_s3_bucket_server_side_encryption_configuration", "module.a.sse", "module.a", {"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "AES256"}]}]})
	count(terraform.deny) == 0 with input as plan([logs, good_pab, aes])
}

test_queue_without_cmk_denied if {
	q := rc("aws_sqs_queue", "module.q.aws_sqs_queue.x", "module.q", {"name": "vsp-test-x", "kms_master_key_id": null, "redrive_policy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:111111111111:d\",\"maxReceiveCount\":5}", "tags": {}})
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([q])
}

test_wired_cmk_accepted_when_unknown if {
	q := rc_unknown("aws_sqs_queue", "module.q.aws_sqs_queue.x", "module.q", {"name": "vsp-test-x", "kms_master_key_id": null, "redrive_policy": null, "tags": {}}, {"kms_master_key_id": true, "redrive_policy": true})
	count(terraform.deny) == 0 with input as plan([q])
}

test_log_group_without_cmk_denied if {
	lg := rc("aws_cloudwatch_log_group", "module.l.lg", "module.l", {"name": "/vsp/test", "kms_key_id": null})
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([lg])
}

test_unencrypted_rds_denied if {
	c := rc("aws_rds_cluster", "module.d.c", "module.d", {"storage_encrypted": false, "kms_key_id": null})
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([c])
}

test_kms_key_without_rotation_denied if {
	k := rc("aws_kms_key", "module.k.k", "module.k", {"enable_key_rotation": false})
	has_prefix(terraform.deny, "ENCRYPTION") with input as plan([k])
}

test_plain_http_listener_denied if {
	l := rc("aws_lb_listener", "module.i.l", "module.i", {"protocol": "HTTP", "default_action": [{"type": "forward", "redirect": []}]})
	has_prefix(terraform.deny, "TLS") with input as plan([l])
}

test_legacy_tls_policy_denied if {
	l := rc("aws_lb_listener", "module.i.l", "module.i", {"protocol": "HTTPS", "ssl_policy": "ELBSecurityPolicy-2016-08", "default_action": []})
	has_prefix(terraform.deny, "TLS") with input as plan([l])
}

# [SPEC-3.ingress] only 443 to the ALB from the internet
alb_https := rc("aws_vpc_security_group_ingress_rule", "module.ingress.alb_https", "module.ingress", {
	"cidr_ipv4": "0.0.0.0/0", "cidr_ipv6": null, "from_port": 443, "to_port": 443, "ip_protocol": "tcp",
	"tags": {"vsp:exposure": "public-alb-https"},
})

test_alb_https_ingress_allowed if {
	count(terraform.deny) == 0 with input as plan([alb_https])
}

test_open_ssh_denied if {
	ssh := rc("aws_vpc_security_group_ingress_rule", "module.x.ssh", "module.x", {"cidr_ipv4": "0.0.0.0/0", "from_port": 22, "to_port": 22, "ip_protocol": "tcp", "tags": {}})
	has_prefix(terraform.deny, "INGRESS") with input as plan([ssh])
}

test_untagged_open_443_denied if {
	r := rc("aws_vpc_security_group_ingress_rule", "module.x.web", "module.x", {"cidr_ipv4": "0.0.0.0/0", "from_port": 443, "to_port": 443, "ip_protocol": "tcp", "tags": {}})
	has_prefix(terraform.deny, "INGRESS") with input as plan([r])
}

test_ipv6_open_ingress_denied if {
	r := rc("aws_vpc_security_group_ingress_rule", "module.x.v6", "module.x", {"cidr_ipv4": null, "cidr_ipv6": "::/0", "from_port": 5432, "to_port": 5432, "ip_protocol": "tcp", "tags": {}})
	has_prefix(terraform.deny, "INGRESS") with input as plan([r])
}

test_http_redirect_ingress_allowed_only_for_redirect_listener if {
	r80 := rc("aws_vpc_security_group_ingress_rule", "module.ingress.alb_http", "module.ingress", {"cidr_ipv4": "0.0.0.0/0", "from_port": 80, "to_port": 80, "ip_protocol": "tcp", "tags": {"vsp:exposure": "public-alb-http-redirect"}})
	redirect := rc("aws_lb_listener", "module.ingress.http", "module.ingress", {"protocol": "HTTP", "default_action": [{"type": "redirect", "redirect": [{"protocol": "HTTPS"}]}]})
	forward := rc("aws_lb_listener", "module.ingress.http", "module.ingress", {"protocol": "HTTP", "default_action": [{"type": "forward", "redirect": []}]})
	count(terraform.deny) == 0 with input as plan([r80, redirect])
	has_prefix(terraform.deny, "INGRESS") with input as plan([r80, forward])
}

test_public_task_ip_denied if {
	s := rc("aws_ecs_service", "module.e.s", "module.e", {"network_configuration": [{"assign_public_ip": true}]})
	has_prefix(terraform.deny, "INGRESS") with input as plan([s])
}

test_second_internet_facing_lb_denied if {
	lb := rc("aws_lb", "module.x.lb", "module.x", {"internal": false, "tags": {}})
	has_prefix(terraform.deny, "INGRESS") with input as plan([lb])
}

test_public_database_denied if {
	i := rc("aws_rds_cluster_instance", "module.d.i", "module.d", {"publicly_accessible": true, "performance_insights_enabled": false})
	has_prefix(terraform.deny, "INGRESS") with input as plan([i])
}

# [SPEC-3.sessions] PITR
test_dynamodb_without_pitr_denied if {
	t := rc_unknown("aws_dynamodb_table", "module.s.t", "module.s", {"point_in_time_recovery": [{"enabled": false}], "server_side_encryption": [{"enabled": true}]}, {"server_side_encryption": [{"kms_key_arn": true}]})
	has_prefix(terraform.deny, "PITR") with input as plan([t])
}

test_dynamodb_replica_without_pitr_denied if {
	t := rc_unknown(
		"aws_dynamodb_table", "module.s.t", "module.s", {
			"point_in_time_recovery": [{"enabled": true}],
			"server_side_encryption": [{"enabled": true}],
			"replica": [{"region_name": "us-west-2", "point_in_time_recovery": false}],
		},
		{"server_side_encryption": [{"kms_key_arn": true}]},
	)
	has_prefix(terraform.deny, "PITR") with input as plan([t])
}

test_dynamodb_compliant if {
	t := rc_unknown("aws_dynamodb_table", "module.s.t", "module.s", {"point_in_time_recovery": [{"enabled": true}], "server_side_encryption": [{"enabled": true}]}, {"server_side_encryption": [{"kms_key_arn": true}]})
	count(terraform.deny) == 0 with input as plan([t])
}

# [SPEC-3.sqs] DLQ on queues
test_queue_without_dlq_denied if {
	q := rc_unknown("aws_sqs_queue", "module.q.aws_sqs_queue.x", "module.q", {"name": "vsp-test-x", "redrive_policy": null, "tags": {"vsp:queue-role": "primary"}}, {"kms_master_key_id": true})
	has_prefix(terraform.deny, "DLQ") with input as plan([q])
}

test_dlq_itself_needs_no_redrive if {
	q := rc_unknown("aws_sqs_queue", "module.q.aws_sqs_queue.d", "module.q", {"name": "vsp-test-x-dlq", "redrive_policy": null, "tags": {"vsp:queue-role": "dlq"}}, {"kms_master_key_id": true})
	count(terraform.deny) == 0 with input as plan([q])
}

test_unbounded_redrive_denied if {
	q := rc_unknown("aws_sqs_queue", "module.q.aws_sqs_queue.x", "module.q", {"name": "vsp-test-x", "redrive_policy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:111111111111:d\",\"maxReceiveCount\":1000}", "tags": {}}, {"kms_master_key_id": true})
	has_prefix(terraform.deny, "DLQ") with input as plan([q])
}

# [OPS-01] audit Object Lock
audit_bucket := rc("aws_s3_bucket", "module.audit.aws_s3_bucket.audit", "module.audit", {"bucket": "vsp-test-audit", "object_lock_enabled": true, "tags": {"vsp:object-lock": "required"}})

audit_pab := rc("aws_s3_bucket_public_access_block", "module.audit.pab", "module.audit", {"block_public_acls": true, "block_public_policy": true, "ignore_public_acls": true, "restrict_public_buckets": true})

audit_sse := rc("aws_s3_bucket_server_side_encryption_configuration", "module.audit.sse", "module.audit", {"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "aws:kms"}]}]})

audit_versioning := rc("aws_s3_bucket_versioning", "module.audit.v", "module.audit", {"versioning_configuration": [{"status": "Enabled"}]})

audit_lock := rc("aws_s3_bucket_object_lock_configuration", "module.audit.lock", "module.audit", {"rule": [{"default_retention": [{"mode": "COMPLIANCE", "days": 1}]}]})

test_audit_bucket_compliant if {
	count(terraform.deny) == 0 with input as plan([audit_bucket, audit_pab, audit_sse, audit_versioning, audit_lock])
}

test_audit_bucket_without_lock_configuration_denied if {
	has_prefix(terraform.deny, "OBJECT-LOCK") with input as plan([audit_bucket, audit_pab, audit_sse, audit_versioning])
}

test_audit_bucket_without_object_lock_denied if {
	b := rc("aws_s3_bucket", "module.audit.aws_s3_bucket.audit", "module.audit", {"bucket": "vsp-test-audit", "object_lock_enabled": false, "tags": {"vsp:object-lock": "required"}})
	has_prefix(terraform.deny, "OBJECT-LOCK") with input as plan([b, audit_pab, audit_sse, audit_versioning, audit_lock])
}

test_audit_bucket_zero_retention_denied if {
	lock := rc("aws_s3_bucket_object_lock_configuration", "module.audit.lock", "module.audit", {"rule": [{"default_retention": [{"mode": "GOVERNANCE", "days": 0}]}]})
	has_prefix(terraform.deny, "OBJECT-LOCK") with input as plan([audit_bucket, audit_pab, audit_sse, audit_versioning, lock])
}

test_audit_bucket_unversioned_denied if {
	has_prefix(terraform.deny, "OBJECT-LOCK") with input as plan([audit_bucket, audit_pab, audit_sse, audit_lock])
}

# [DATA-01] Step Functions logs exclude execution data
sfn(include, level, type) := rc("aws_sfn_state_machine", "module.w.m", "module.w", {
	"type": type,
	"logging_configuration": [{"include_execution_data": include, "level": level}],
	"encryption_configuration": [{"type": "CUSTOMER_MANAGED_KMS_KEY"}],
})

test_sfn_compliant if {
	count(terraform.deny) == 0 with input as plan([sfn(false, "ERROR", "STANDARD")])
}

test_sfn_execution_data_denied if {
	has_prefix(terraform.deny, "SFN-LOGS") with input as plan([sfn(true, "ERROR", "STANDARD")])
}

test_sfn_logging_off_denied if {
	has_prefix(terraform.deny, "SFN-LOGS") with input as plan([sfn(false, "OFF", "STANDARD")])
}

test_sfn_express_denied if {
	has_prefix(terraform.deny, "SFN-TYPE") with input as plan([sfn(false, "ERROR", "EXPRESS")])
}

# [DATA-01] no PHI-like content in names or alert text
test_phone_number_in_alarm_text_denied if {
	a := rc("aws_cloudwatch_metric_alarm", "module.o.a", "module.o", {"alarm_name": "x", "alarm_description": "caller 555-555-0123 failed"})
	has_prefix(terraform.deny, "NAMING") with input as plan([a])
}

test_email_in_name_denied if {
	lg := rc_unknown("aws_cloudwatch_log_group", "module.l.lg", "module.l", {"name": "/vsp/jane.doe@example.com"}, {"kms_key_id": true})
	has_prefix(terraform.deny, "NAMING") with input as plan([lg])
}

# [SPEC-14.iam] IAM checks on known policies
test_iam_star_action_denied if {
	p := rc("aws_iam_role_policy", "module.i.p", "module.i", {"policy": json.marshal({"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]})})
	has_prefix(terraform.deny, "IAM") with input as plan([p])
}

test_public_trust_denied if {
	r := rc("aws_iam_role", "module.i.r", "module.i", {"assume_role_policy": json.marshal({"Statement": [{"Effect": "Allow", "Principal": {"AWS": "*"}, "Action": "sts:AssumeRole"}]})})
	has_prefix(terraform.deny, "IAM") with input as plan([r])
}

github_trust(sub) := rc("aws_iam_role", "module.ci.r", "module.ci", {"assume_role_policy": json.marshal({"Statement": [{
	"Effect": "Allow",
	"Principal": {"Federated": "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"},
	"Action": "sts:AssumeRoleWithWebIdentity",
	"Condition": {"StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": sub}},
}]})})

pinned_subject(env) := sprintf("repo:example-owner/example-repo:environment:%s:job_workflow_ref:example-owner/example-repo/.github/workflows/deploy.yml@refs/heads/main", [env])

test_github_exact_subject_allowed if {
	count(terraform.deny) == 0 with input as plan([github_trust(pinned_subject("production"))])
	count(terraform.deny) == 0 with input as plan([github_trust(pinned_subject("production-plan"))])
}

# [SPEC-14.iam][VSP-INF-03] an environment-only subject can be claimed by a job on any branch
test_github_environment_only_subject_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:environment:production")])
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:environment:production-plan")])
}

test_github_wildcard_workflow_ref_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:environment:production:job_workflow_ref:example-owner/example-repo/.github/workflows/deploy.yml@refs/heads/*")])
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:environment:production:job_workflow_ref:example-owner/example-repo/.github/workflows/*@refs/heads/main")])
}

test_github_wildcard_subject_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/*")])
}

test_github_branch_subject_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:ref:refs/heads/main")])
}

# ------------------------------------------------------------ WAF log redaction

waf_logging(fields) := rc("aws_wafv2_web_acl_logging_configuration", "module.ingress.aws_wafv2_web_acl_logging_configuration.this", "module.ingress", {"redacted_fields": fields})

waf_header(name) := {"method": [], "query_string": [], "single_header": [{"name": name}], "uri_path": []}

waf_query := {"method": [], "query_string": [{}], "single_header": [], "uri_path": []}

waf_all_headers := [waf_header(h) | some h in ["authorization", "cookie", "mcp-session-id", "x-vsp-session-ref", "x-vsp-interaction-id", "idempotency-key"]]

# [AUTH-06][VSP-INF-01] credentials and bearer references are redacted from WAF logs
test_waf_logging_with_all_redactions_passes if {
	count(terraform.deny) == 0 with input as plan([waf_logging(array.concat(waf_all_headers, [waf_query]))])
}

# [AUTH-06][VSP-INF-01] the original four-field configuration logged X-VSP-Session-Ref and Idempotency-Key
test_waf_logging_without_session_ref_denied if {
	old := [waf_header("authorization"), waf_header("cookie"), waf_header("mcp-session-id"), waf_query]
	msgs := terraform.deny with input as plan([waf_logging(old)])
	some m in msgs
	startswith(m, "WAF-LOGS")
	contains(m, "x-vsp-session-ref")
	contains(m, "idempotency-key")
	contains(m, "x-vsp-interaction-id")
}

test_waf_logging_without_query_string_denied if {
	has_prefix(terraform.deny, "WAF-LOGS") with input as plan([waf_logging(waf_all_headers)])
}

# WAF matches lowercase header names only
test_waf_logging_uppercase_header_does_not_count if {
	fields := array.concat([waf_header("X-VSP-Session-Ref")], array.concat([h | some h in waf_all_headers; h.single_header[0].name != "x-vsp-session-ref"], [waf_query]))
	has_prefix(terraform.deny, "WAF-LOGS") with input as plan([waf_logging(fields)])
}

# ------------------------------------------------------------ IAM evaluator

# [VSP-INF-02] Bool / BoolIfExists: an absent key fails Bool and holds for BoolIfExists; values compare case-insensitively
test_iam_evaluator_bool_semantics if {
	doc := {"Statement": [
		{"Effect": "Allow", "Action": ["kms:*", "secretsmanager:*"], "Resource": "*"},
		{"Effect": "Deny", "Action": ["kms:CreateGrant", "secretsmanager:PutResourcePolicy"], "Resource": "*", "Condition": {"BoolIfExists": {"kms:GrantIsForAWSResource": "false", "secretsmanager:BlockPublicPolicy": "false"}}},
		{"Effect": "Deny", "Action": "kms:RevokeGrant", "Resource": "*", "Condition": {"Bool": {"kms:GrantIsForAWSResource": "false"}}},
	]}
	not terraform.iam_allows(doc, "kms:CreateGrant", "k", {})
	not terraform.iam_allows(doc, "kms:CreateGrant", "k", {"kms:GrantIsForAWSResource": "False"})
	terraform.iam_allows(doc, "kms:CreateGrant", "k", {"kms:GrantIsForAWSResource": true})
	not terraform.iam_allows(doc, "secretsmanager:PutResourcePolicy", "s", {})
	terraform.iam_allows(doc, "secretsmanager:PutResourcePolicy", "s", {"secretsmanager:BlockPublicPolicy": "true"})
	terraform.iam_allows(doc, "kms:RevokeGrant", "k", {}) # Bool: absent key does not hold
	not terraform.iam_allows(doc, "kms:RevokeGrant", "k", {"kms:GrantIsForAWSResource": "false"})
}

test_iam_evaluator_semantics if {
	doc := {"Statement": [
		{"Effect": "Allow", "Action": ["iam:*", "dynamodb:*"], "Resource": "*"},
		{"Effect": "Deny", "Action": "iam:PutRolePolicy", "Resource": "arn:aws:iam::111111111111:role/x"},
		{"Effect": "Deny", "NotAction": ["iam:*"], "Resource": "*", "Condition": {"StringNotEquals": {"aws:RequestedRegion": ["us-east-1"]}}},
		{"Effect": "Deny", "Action": "iam:UpdateAssumeRolePolicy", "NotResource": ["arn:aws:iam::111111111111:role/vsp-*"]},
		{"Effect": "Deny", "Action": "dynamodb:GetItem", "Resource": "*", "Condition": {"ArnEquals": {"aws:PrincipalArn": ["arn:aws:iam::111111111111:role/ci"]}}},
	]}
	terraform.iam_explicit_deny(doc, "IAM:PUTROLEPOLICY", "arn:aws:iam::111111111111:role/x", {})
	terraform.iam_allows(doc, "iam:PutRolePolicy", "arn:aws:iam::111111111111:role/y", {})
	not terraform.iam_allows(doc, "dynamodb:Scan", "t", {"aws:RequestedRegion": "eu-west-1"})
	terraform.iam_allows(doc, "dynamodb:Scan", "t", {"aws:RequestedRegion": "us-east-1"})
	not terraform.iam_allows(doc, "dynamodb:Scan", "t", {}) # negated operator: absent key holds
	not terraform.iam_allows(doc, "iam:UpdateAssumeRolePolicy", "arn:aws:iam::111111111111:role/Admin", {})
	terraform.iam_allows(doc, "iam:UpdateAssumeRolePolicy", "arn:aws:iam::111111111111:role/vsp-task", {})
	not terraform.iam_allows(doc, "dynamodb:GetItem", "t", {"aws:RequestedRegion": "us-east-1", "aws:PrincipalArn": "arn:aws:iam::111111111111:role/ci"})
	terraform.iam_allows(doc, "dynamodb:GetItem", "t", {"aws:RequestedRegion": "us-east-1", "aws:PrincipalArn": "arn:aws:iam::111111111111:role/task"})
	terraform.iam_allows(doc, "dynamodb:GetItem", "t", {"aws:RequestedRegion": "us-east-1"}) # positive operator: absent key does not hold
}

# ------------------------------------------------------------ CI boundary (VSP-INF-02)

boundary_arn := "arn:aws:iam::111111111111:policy/vsp-test-ci-boundary"

ci_roles := ["arn:aws:iam::111111111111:role/vsp-test-gha-plan", "arn:aws:iam::111111111111:role/vsp-test-gha-apply"]

surface := {"Sid": "MaximumServiceSurface", "Effect": "Allow", "Action": ["iam:*", "sts:AssumeRole", "dynamodb:*", "secretsmanager:*", "sqs:*", "logs:*", "kms:*", "s3:*", "rds:*"], "Resource": "*"}

regions := {"Sid": "OnlyApprovedRegions", "Effect": "Deny", "NotAction": ["iam:*", "sts:*"], "Resource": "*", "Condition": {"StringNotEquals": {"aws:RequestedRegion": ["us-east-1"]}}}

# The shape of the boundary before VSP-INF-02.
old_boundary := {"Statement": [
	surface,
	regions,
	{"Sid": "NoLongLivedCredentials", "Effect": "Deny", "Action": ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile", "iam:AttachUserPolicy", "iam:PutUserPolicy"], "Resource": "*"},
	{"Sid": "RolesMustCarryThisBoundary", "Effect": "Deny", "Action": ["iam:CreateRole", "iam:PutRolePermissionsBoundary"], "Resource": "*", "Condition": {"StringNotEquals": {"iam:PermissionsBoundary": boundary_arn}}},
	{"Sid": "BoundaryIsImmutableToCi", "Effect": "Deny", "Action": ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"], "Resource": [boundary_arn, "arn:aws:iam::111111111111:role/*"]},
]}

data_reads := ["dynamodb:GetItem", "dynamodb:Scan", "secretsmanager:GetSecretValue", "sqs:ReceiveMessage", "logs:FilterLogEvents", "kms:Decrypt"]

data_exports := [
	"dynamodb:ExportTableToPointInTime", "dynamodb:PutResourcePolicy", "rds:ModifyDBClusterSnapshotAttribute", "rds:ModifyDBSnapshotAttribute",
	"rds:StartExportTask", "logs:CreateExportTask", "logs:PutSubscriptionFilter", "s3:PutReplicationConfiguration", "s3:PutBucketAcl", "sqs:AddPermission",
]

ci_data_condition := {"ArnEquals": {"aws:PrincipalArn": ci_roles}, "StringNotLike": {"kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::vsp-test-tfstate/envs/sandbox/*"}}

scoped_sharing := {"Sid": "SharingOnlyViaAwsServicesOrPrivately", "Effect": "Deny", "Action": ["kms:CreateGrant", "secretsmanager:PutResourcePolicy"], "Resource": "*", "Condition": {"BoolIfExists": {"kms:GrantIsForAWSResource": "false", "secretsmanager:BlockPublicPolicy": "false"}}}

# The boundary after the first VSP-INF-02 fix: identity and escalation closed, reads denied, but no export or sharing deny.
round1_boundary := {"Statement": [
	surface,
	regions,
	{"Sid": "NoLongLivedCredentials", "Effect": "Deny", "Action": ["iam:CreateUser", "iam:CreateAccessKey", "iam:AttachGroupPolicy"], "Resource": "*"},
	{"Sid": "RolesMustCarryThisBoundary", "Effect": "Deny", "Action": ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"], "Resource": "*", "Condition": {"StringNotEquals": {"iam:PermissionsBoundary": boundary_arn}}},
	{"Sid": "CiIdentityIsImmutableToCi", "Effect": "Deny", "Action": ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"], "Resource": ci_roles},
	{"Sid": "OnlyRolesCreatedByCiCanBeChangedOrPassed", "Effect": "Deny", "Action": ["iam:UpdateAssumeRolePolicy", "iam:PassRole"], "NotResource": ["arn:aws:iam::111111111111:role/vsp-test-*"]},
	{"Sid": "NoInAccountRoleAssumption", "Effect": "Deny", "Action": ["sts:AssumeRole"], "Resource": ["arn:aws:iam::111111111111:role/*"]},
	{"Sid": "NoIdentityProviderChanges", "Effect": "Deny", "Action": ["iam:CreateOpenIDConnectProvider"], "Resource": "*"},
	{"Sid": "NoManagedPolicyChanges", "Effect": "Deny", "Action": ["iam:CreatePolicyVersion"], "Resource": "*"},
	{"Sid": "NoDataPlaneReadsForCi", "Effect": "Deny", "Action": data_reads, "Resource": "*", "Condition": ci_data_condition},
]}

# The fixed boundary: the shared deny also lists the export and sharing calls, plus the scoped sharing statement.
new_boundary := {"Statement": array.concat(
	[s | some s in round1_boundary.Statement; s.Sid != "NoDataPlaneReadsForCi"],
	[{"Sid": "NoDataPlaneReadsForCi", "Effect": "Deny", "Action": array.concat(data_reads, data_exports), "Resource": "*", "Condition": ci_data_condition}, scoped_sharing],
)}

boundary_rc(doc) := rc("aws_iam_policy", "module.stack.module.iam_ci[0].aws_iam_policy.boundary", "module.stack.module.iam_ci[0]", {"name": "vsp-test-ci-boundary", "policy": json.marshal(doc)})

# [SPEC-14.iam][VSP-INF-02] the fixed boundary closes every probed path
test_ci_boundary_compliant if {
	count(terraform.deny) == 0 with input as plan([boundary_rc(new_boundary)])
}

# [SPEC-14.iam][VSP-INF-02] the original boundary let the apply role rewrite itself, widen a pre-existing role, assume it and read data
test_ci_boundary_before_fix_denied if {
	msgs := terraform.deny with input as plan([boundary_rc(old_boundary)])
	some self_change in msgs
	contains(self_change, "iam:PutRolePolicy on its own role arn:aws:iam::111111111111:role/vsp-test-gha-apply")
	some trust in msgs
	contains(trust, "iam:UpdateAssumeRolePolicy on its own role")
	some foreign in msgs
	contains(foreign, "iam:AttachRolePolicy on a role CI did not create")
	some assume in msgs
	contains(assume, "sts:AssumeRole into an in-account role")
	some read in msgs
	contains(read, "dynamodb:GetItem by CI role")
	some idp in msgs
	contains(idp, "iam:CreateOpenIDConnectProvider")
}

test_ci_boundary_without_self_requirement_denied if {
	doc := {"Statement": [s | some s in new_boundary.Statement; s.Sid != "RolesMustCarryThisBoundary"]}
	has_prefix(terraform.deny, "CI-BOUNDARY") with input as plan([boundary_rc(doc)])
}

# [OPS-05][VSP-INF-02] the round-1 boundary still let the CI roles export a table (e.g. into the state prefix the
# apply role reads back), share a table, snapshot or secret with another account, or grant a KMS key directly
test_ci_boundary_round1_export_and_sharing_denied if {
	msgs := terraform.deny with input as plan([boundary_rc(round1_boundary)])
	some export in msgs
	contains(export, "dynamodb:ExportTableToPointInTime (export or share) by CI role arn:aws:iam::111111111111:role/vsp-test-gha-apply")
	some table_policy in msgs
	contains(table_policy, "dynamodb:PutResourcePolicy (export or share) by CI role")
	some snapshot in msgs
	contains(snapshot, "rds:ModifyDBClusterSnapshotAttribute (export or share) by CI role")
	some logs in msgs
	contains(logs, "logs:CreateExportTask (export or share) by CI role")
	some grant in msgs
	contains(grant, "kms:CreateGrant outside an AWS-service grant or a non-public policy by CI role")
	some secret in msgs
	contains(secret, "secretsmanager:PutResourcePolicy outside an AWS-service grant or a non-public policy by CI role")
}

# [OPS-05][VSP-INF-02] every export or sharing action is probed: dropping any one from the deny reopens it
test_ci_boundary_each_export_is_needed if {
	every a in data_exports {
		doc := {"Statement": array.concat(
			[s | some s in new_boundary.Statement; s.Sid != "NoDataPlaneReadsForCi"],
			[{"Sid": "NoDataPlaneReadsForCi", "Effect": "Deny", "Action": array.concat(data_reads, [x | some x in data_exports; x != a]), "Resource": "*", "Condition": ci_data_condition}],
		)}
		some m in terraform.deny with input as plan([boundary_rc(doc)])
		contains(m, sprintf("%s (export or share) by CI role", [a]))
	}
}

# [VSP-INF-02] each statement is load-bearing: dropping any one reopens a path
test_ci_boundary_each_deny_is_needed if {
	every sid in ["CiIdentityIsImmutableToCi", "OnlyRolesCreatedByCiCanBeChangedOrPassed", "NoInAccountRoleAssumption", "NoIdentityProviderChanges", "NoManagedPolicyChanges", "NoDataPlaneReadsForCi", "SharingOnlyViaAwsServicesOrPrivately", "NoLongLivedCredentials"] {
		doc := {"Statement": [s | some s in new_boundary.Statement; s.Sid != sid]}
		has_prefix(terraform.deny, "CI-BOUNDARY") with input as plan([boundary_rc(doc)])
	}
}

# The boundary still admits what deployment and task roles need.
test_ci_boundary_keeps_deploy_paths if {
	ctx := {"aws:RequestedRegion": "us-east-1", "iam:PermissionsBoundary": boundary_arn}
	terraform.iam_allows(new_boundary, "iam:PutRolePolicy", "arn:aws:iam::111111111111:role/vsp-test-gateway-task", ctx)
	terraform.iam_allows(new_boundary, "iam:PassRole", "arn:aws:iam::111111111111:role/vsp-test-gateway-task", ctx)
	terraform.iam_allows(new_boundary, "sts:AssumeRole", "arn:aws:iam::222222222222:role/vsp-audit-writer", ctx)
	terraform.iam_allows(new_boundary, "dynamodb:GetItem", "arn:aws:dynamodb:us-east-1:111111111111:table/s", {"aws:RequestedRegion": "us-east-1", "aws:PrincipalArn": "arn:aws:iam::111111111111:role/vsp-test-gateway-task"})
	terraform.iam_allows(new_boundary, "kms:Decrypt", "k", {"aws:RequestedRegion": "us-east-1", "aws:PrincipalArn": ci_roles[0], "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::vsp-test-tfstate/envs/sandbox/terraform.tfstate"})

	# [VSP-INF-02] what Terraform does call stays allowed: grants an AWS service creates (RDS, DynamoDB),
	# secret policies with Block Public Policy, and the resource policies the stack manages (residual risk).
	ci := {"aws:RequestedRegion": "us-east-1", "aws:PrincipalArn": ci_roles[1]}
	terraform.iam_allows(new_boundary, "kms:CreateGrant", "k", object.union(ci, {"kms:GrantIsForAWSResource": "true"}))
	terraform.iam_allows(new_boundary, "secretsmanager:PutResourcePolicy", "s", object.union(ci, {"secretsmanager:BlockPublicPolicy": "true"}))
	terraform.iam_allows(new_boundary, "s3:PutBucketPolicy", "arn:aws:s3:::vsp-test-alb-logs", ci)
	terraform.iam_allows(new_boundary, "sqs:SetQueueAttributes", "q", ci)
	terraform.iam_allows(new_boundary, "kms:PutKeyPolicy", "k", ci)
	terraform.iam_allows(new_boundary, "dynamodb:UpdateTable", "t", ci)
}

# ------------------------------------------------------------ Terraform state (VSP-INF-03)

plan_policy(statements) := rc("aws_iam_role_policy", "module.stack.module.iam_ci[0].aws_iam_role_policy.plan", "module.stack.module.iam_ci[0]", {"name": "state-and-data-plane-deny", "policy": json.marshal({"Statement": statements})})

apply_policy(statements) := rc("aws_iam_role_policy", "module.stack.module.iam_ci[0].aws_iam_role_policy.apply", "module.stack.module.iam_ci[0]", {"name": "deploy-within-boundary", "policy": json.marshal({"Statement": statements})})

state_read := {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::b/envs/x/*"]}

lock_write := {"Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::b/envs/x/*.tflock"]}

# [VSP-INF-03] the original plan grant covered the state object itself
test_plan_role_state_write_denied if {
	old := {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::b/envs/x/*"]}
	has_prefix(terraform.deny, "CI-STATE") with input as plan([plan_policy([old])])
	has_prefix(terraform.deny, "CI-STATE") with input as plan([plan_policy([{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}])])
}

test_plan_role_lock_only_allowed if {
	count(terraform.deny) == 0 with input as plan([plan_policy([state_read, lock_write])])
}

test_apply_role_wildcard_s3_needs_explicit_delete_deny if {
	deploy := {"Effect": "Allow", "Action": ["s3:*", "iam:*"], "Resource": "*"}
	keep := {"Effect": "Deny", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"], "NotResource": ["arn:aws:s3:::b/envs/x/*.tflock"]}
	has_prefix(terraform.deny, "CI-STATE") with input as plan([apply_policy([deploy, state_read, lock_write])])
	count(terraform.deny) == 0 with input as plan([apply_policy([deploy, state_read, lock_write, keep])])
}

test_apply_role_state_delete_denied if {
	has_prefix(terraform.deny, "CI-STATE") with input as plan([apply_policy([{"Effect": "Allow", "Action": ["s3:DeleteObject"], "Resource": ["arn:aws:s3:::b/envs/x/*"]}])])
	count(terraform.deny) == 0 with input as plan([apply_policy([state_read, lock_write, {"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": ["arn:aws:s3:::b/envs/x/*"]}])])
}

# [VSP-INF-02] a reviewed plan cannot change the CI identity (administrator-applied only)
test_ci_identity_change_denied if {
	upd := {"type": "aws_iam_role_policy", "address": "module.stack.module.iam_ci[0].aws_iam_role_policy.apply", "module_address": "module.stack.module.iam_ci[0]", "change": {"actions": ["update"], "after": {"name": "deploy-within-boundary", "policy": json.marshal({"Statement": [state_read, lock_write]})}, "after_unknown": {}}}
	has_prefix(terraform.deny, "CI-IDENTITY") with input as plan([upd])
	gone := {"type": "aws_iam_role", "address": "module.iam_ci.aws_iam_role.plan", "module_address": "module.iam_ci", "change": {"actions": ["delete"], "after": null}}
	has_prefix(terraform.deny, "CI-IDENTITY") with input as plan([gone])
}

test_ci_identity_creation_and_other_modules_allowed if {
	created := rc("aws_iam_role", "module.stack.module.iam_ci[0].aws_iam_role.plan", "module.stack.module.iam_ci[0]", {"name": "vsp-test-gha-plan"})
	count(terraform.deny) == 0 with input as plan([created])
	task := {"type": "aws_iam_role", "address": "module.stack.module.ecs_service.aws_iam_role.task", "module_address": "module.stack.module.ecs_service", "change": {"actions": ["update"], "after": {"name": "vsp-test-gateway-task"}, "after_unknown": {}}}
	count(terraform.deny) == 0 with input as plan([task])
}

# ------------------------------------------------------------ summary

test_summary_reports_fail if {
	terraform.summary.result == "FAIL" with input as plan([good_bucket])
}

test_deleted_resources_are_ignored if {
	gone := {"type": "aws_s3_bucket", "address": "x", "module_address": "m", "change": {"actions": ["delete"], "after": null}}
	count(terraform.deny) == 0 with input as plan([gone])
}
