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

test_github_exact_subject_allowed if {
	count(terraform.deny) == 0 with input as plan([github_trust("repo:example-owner/example-repo:environment:production")])
}

test_github_wildcard_subject_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/*")])
}

test_github_branch_subject_denied if {
	has_prefix(terraform.deny, "IAM") with input as plan([github_trust("repo:example-owner/example-repo:ref:refs/heads/main")])
}

# ------------------------------------------------------------ summary

test_summary_reports_fail if {
	terraform.summary.result == "FAIL" with input as plan([good_bucket])
}

test_deleted_resources_are_ignored if {
	gone := {"type": "aws_s3_bucket", "address": "x", "module_address": "m", "change": {"actions": ["delete"], "after": null}}
	count(terraform.deny) == 0 with input as plan([gone])
}
