# Infrastructure policy checks over `terraform show -json <plan>` (spec section 14:
# "infrastructure policy checks"). Evaluated in CI with the pinned OPA binary:
#
#   opa eval -d infra/terraform/policy -i plan.json 'data.vsp.terraform.deny'
#
# A non-empty `deny` set fails the gate. Values that are unknown at plan time
# (computed ARNs) are accepted where the attribute is wired to a resource; their
# content is verified by the module-level `terraform test` suites instead.
# Offline, scripts/terraform-policy.sh evaluates these rules against fake-credential
# plans of every environment (no AWS access); a real-account plan is NOT RUN here.
package vsp.terraform

# ---------------------------------------------------------------- helpers

planned contains rc if {
	some rc in input.resource_changes
	some action in rc.change.actions
	action in {"create", "update"}
}

of_type(t) := {rc | some rc in planned; rc.type == t}

after(rc) := object.get(rc.change, "after", {})

unknown_flags(rc) := object.get(rc.change, "after_unknown", {})

# Attribute is configured: known non-null, or unknown because it references another resource.
wired(rc, path) if {
	object.get(after(rc), path, null) != null
}

wired(rc, path) if {
	object.get(unknown_flags(rc), path, false) == true
}

tag(rc, key) := object.get(object.get(after(rc), "tags", {}), key, "")

module_of(rc) := object.get(rc, "module_address", "")

open_cidrs := {"0.0.0.0/0", "::/0"}

approved_tls_policy(p) if startswith(p, "ELBSecurityPolicy-TLS13-")

# ---------------------------------------------------------------- 1. no public S3

deny contains msg if {
	some b in of_type("aws_s3_bucket")
	m := module_of(b)
	buckets := count({x | some x in of_type("aws_s3_bucket"); module_of(x) == m})
	blocks := count({p |
		some p in of_type("aws_s3_bucket_public_access_block")
		module_of(p) == m
		fully_blocked(p)
	})
	blocks < buckets
	msg := sprintf("S3-PUBLIC: %s lacks a public access block with all four settings true", [b.address])
}

fully_blocked(p) if {
	a := after(p)
	a.block_public_acls == true
	a.block_public_policy == true
	a.ignore_public_acls == true
	a.restrict_public_buckets == true
}

deny contains msg if {
	some acl in of_type("aws_s3_bucket_acl")
	object.get(after(acl), "acl", "") in {"public-read", "public-read-write", "authenticated-read"}
	msg := sprintf("S3-PUBLIC: %s grants a public canned ACL", [acl.address])
}

deny contains msg if {
	some pol in of_type("aws_s3_bucket_policy")
	doc := json.unmarshal(after(pol).policy)
	some st in doc.Statement
	st.Effect == "Allow"
	public_principal(st.Principal)
	not st.Condition
	msg := sprintf("S3-PUBLIC: %s allows an unconditioned public principal", [pol.address])
}

public_principal("*")

public_principal(p) if p.AWS == "*"

# ---------------------------------------------------------------- 2. encryption everywhere

deny contains msg if {
	some b in of_type("aws_s3_bucket")
	m := module_of(b)
	buckets := count({x | some x in of_type("aws_s3_bucket"); module_of(x) == m})
	encs := count({e | some e in of_type("aws_s3_bucket_server_side_encryption_configuration"); module_of(e) == m})
	encs < buckets
	msg := sprintf("ENCRYPTION: %s has no server-side encryption configuration", [b.address])
}

deny contains msg if {
	some e in of_type("aws_s3_bucket_server_side_encryption_configuration")
	some rule in after(e).rule
	some d in rule.apply_server_side_encryption_by_default
	not d.sse_algorithm in {"aws:kms", "aws:kms:dsse"}
	not sse_s3_exception(module_of(e))
	msg := sprintf("ENCRYPTION: %s uses %s without a documented service exception", [e.address, d.sse_algorithm])
}

# SSE-S3 only where the AWS service requires it (ALB access logs, S3 server access logs).
sse_s3_exception(m) if {
	some b in of_type("aws_s3_bucket")
	module_of(b) == m
	tag(b, "vsp:encryption-exception") in {"alb-access-logs-require-sse-s3", "s3-server-access-log-target-requires-sse-s3"}
}

deny contains msg if {
	some t in of_type("aws_dynamodb_table")
	not dynamodb_cmk(t)
	msg := sprintf("ENCRYPTION: %s must use SSE with a customer-managed key", [t.address])
}

dynamodb_cmk(t) if {
	sse := after(t).server_side_encryption[0]
	sse.enabled == true
	wired(t, ["server_side_encryption", 0, "kms_key_arn"])
}

deny contains msg if {
	some q in of_type("aws_sqs_queue")
	not wired(q, ["kms_master_key_id"])
	msg := sprintf("ENCRYPTION: %s must use a KMS customer-managed key", [q.address])
}

deny contains msg if {
	some c in of_type("aws_rds_cluster")
	not rds_encrypted(c)
	msg := sprintf("ENCRYPTION: %s must be storage-encrypted with a CMK", [c.address])
}

rds_encrypted(c) if {
	after(c).storage_encrypted == true
	wired(c, ["kms_key_id"])
}

deny contains msg if {
	some i in of_type("aws_rds_cluster_instance")
	after(i).performance_insights_enabled == true
	not wired(i, ["performance_insights_kms_key_id"])
	msg := sprintf("ENCRYPTION: %s Performance Insights must use a CMK", [i.address])
}

deny contains msg if {
	some t in {"aws_cloudwatch_log_group", "aws_secretsmanager_secret"}
	some r in of_type(t)
	not wired(r, ["kms_key_id"])
	msg := sprintf("ENCRYPTION: %s must use a KMS customer-managed key", [r.address])
}

deny contains msg if {
	some s in of_type("aws_sns_topic")
	not wired(s, ["kms_master_key_id"])
	msg := sprintf("ENCRYPTION: %s must use a KMS customer-managed key", [s.address])
}

deny contains msg if {
	some m in of_type("aws_sfn_state_machine")
	object.get(after(m), ["encryption_configuration", 0, "type"], "") != "CUSTOMER_MANAGED_KMS_KEY"
	msg := sprintf("ENCRYPTION: %s must be encrypted with a customer-managed key", [m.address])
}

deny contains msg if {
	some r in of_type("aws_ecr_repository")
	object.get(after(r), ["encryption_configuration", 0, "encryption_type"], "") != "KMS"
	msg := sprintf("ENCRYPTION: %s must use KMS encryption", [r.address])
}

deny contains msg if {
	some k in of_type("aws_kms_key")
	after(k).enable_key_rotation != true
	msg := sprintf("ENCRYPTION: %s must enable automatic key rotation", [k.address])
}

deny contains msg if {
	some l in of_type("aws_lb_listener")
	not tls_or_redirect(l)
	msg := sprintf("TLS: %s must be HTTPS with a TLS13 policy, or an HTTP redirect to HTTPS", [l.address])
}

tls_or_redirect(l) if {
	after(l).protocol == "HTTPS"
	approved_tls_policy(after(l).ssl_policy)
}

tls_or_redirect(l) if http_redirect_only(l)

http_redirect_only(l) if {
	after(l).protocol == "HTTP"
	actions := after(l).default_action
	count(actions) == 1
	actions[0].type == "redirect"
	actions[0].redirect[0].protocol == "HTTPS"
}

# ---------------------------------------------------------------- 3. internet exposure

deny contains msg if {
	some r in of_type("aws_vpc_security_group_ingress_rule")
	open_source(r)
	not allowed_public_ingress(r)
	msg := sprintf("INGRESS: %s opens %v-%v to the internet; only 443 on the public ALB is allowed", [r.address, after(r).from_port, after(r).to_port])
}

open_source(r) if after(r).cidr_ipv4 in open_cidrs

open_source(r) if after(r).cidr_ipv6 in open_cidrs

allowed_public_ingress(r) if {
	tag(r, "vsp:exposure") == "public-alb-https"
	after(r).ip_protocol == "tcp"
	after(r).from_port == 443
	after(r).to_port == 443
}

allowed_public_ingress(r) if {
	tag(r, "vsp:exposure") == "public-alb-http-redirect"
	after(r).ip_protocol == "tcp"
	after(r).from_port == 80
	after(r).to_port == 80
	http_listeners := {l | some l in of_type("aws_lb_listener"); after(l).protocol == "HTTP"}
	count(http_listeners) > 0
	every l in http_listeners {
		http_redirect_only(l)
	}
}

deny contains msg if {
	some sg in of_type("aws_security_group")
	some ing in object.get(after(sg), "ingress", [])
	some c in array.concat(object.get(ing, "cidr_blocks", []), object.get(ing, "ipv6_cidr_blocks", []))
	c in open_cidrs
	msg := sprintf("INGRESS: %s has an inline internet ingress rule", [sg.address])
}

deny contains msg if {
	some r in of_type("aws_security_group_rule")
	after(r).type == "ingress"
	some c in array.concat(object.get(after(r), "cidr_blocks", []), object.get(after(r), "ipv6_cidr_blocks", []))
	c in open_cidrs
	msg := sprintf("INGRESS: %s is an internet ingress rule outside the ALB pattern", [r.address])
}

deny contains msg if {
	some lb in of_type("aws_lb")
	after(lb).internal == false
	tag(lb, "vsp:exposure") != "public-alb"
	msg := sprintf("INGRESS: %s is internet-facing but is not the designated Talkdesk ingress", [lb.address])
}

deny contains msg if {
	some s in of_type("aws_ecs_service")
	some n in after(s).network_configuration
	n.assign_public_ip == true
	msg := sprintf("INGRESS: %s assigns public IPs to tasks", [s.address])
}

deny contains msg if {
	some i in of_type("aws_rds_cluster_instance")
	after(i).publicly_accessible == true
	msg := sprintf("INGRESS: %s is publicly accessible", [i.address])
}

# ---------------------------------------------------------------- 4. DynamoDB PITR

deny contains msg if {
	some t in of_type("aws_dynamodb_table")
	object.get(after(t), ["point_in_time_recovery", 0, "enabled"], false) != true
	msg := sprintf("PITR: %s must enable point-in-time recovery", [t.address])
}

deny contains msg if {
	some t in of_type("aws_dynamodb_table")
	some rep in object.get(after(t), "replica", [])
	object.get(rep, "point_in_time_recovery", false) != true
	msg := sprintf("PITR: %s replica in %s must enable point-in-time recovery", [t.address, rep.region_name])
}

# ---------------------------------------------------------------- 5. DLQ on queues

deny contains msg if {
	some q in of_type("aws_sqs_queue")
	tag(q, "vsp:queue-role") != "dlq"
	not wired(q, ["redrive_policy"])
	not redrive_resource_for(q)
	msg := sprintf("DLQ: %s has no dead-letter redrive policy", [q.address])
}

redrive_resource_for(q) if {
	some r in of_type("aws_sqs_queue_redrive_policy")
	module_of(r) == module_of(q)
}

deny contains msg if {
	some q in of_type("aws_sqs_queue")
	rp := after(q).redrive_policy
	rp != null
	doc := json.unmarshal(rp)
	not valid_redrive(doc)
	msg := sprintf("DLQ: %s redrive policy must name a DLQ and 1-50 receives", [q.address])
}

valid_redrive(doc) if {
	doc.deadLetterTargetArn
	doc.maxReceiveCount >= 1
	doc.maxReceiveCount <= 50
}

# ---------------------------------------------------------------- 6. audit Object Lock

audit_buckets := {b | some b in of_type("aws_s3_bucket"); tag(b, "vsp:object-lock") == "required"}

deny contains msg if {
	some b in audit_buckets
	after(b).object_lock_enabled != true
	msg := sprintf("OBJECT-LOCK: %s must be created with Object Lock enabled", [b.address])
}

deny contains msg if {
	some b in audit_buckets
	not object_lock_configured(module_of(b))
	msg := sprintf("OBJECT-LOCK: %s needs a default retention (GOVERNANCE/COMPLIANCE, > 0) set by counsel/security", [b.address])
}

object_lock_configured(m) if {
	some c in of_type("aws_s3_bucket_object_lock_configuration")
	module_of(c) == m
	ret := after(c).rule[0].default_retention[0]
	ret.mode in {"GOVERNANCE", "COMPLIANCE"}
	positive_retention(ret)
}

positive_retention(ret) if object.get(ret, "days", 0) > 0

positive_retention(ret) if object.get(ret, "years", 0) > 0

deny contains msg if {
	some b in audit_buckets
	not versioned(module_of(b))
	msg := sprintf("OBJECT-LOCK: %s must have versioning enabled", [b.address])
}

versioned(m) if {
	some v in of_type("aws_s3_bucket_versioning")
	module_of(v) == m
	after(v).versioning_configuration[0].status == "Enabled"
}

# ---------------------------------------------------------------- 7. Step Functions logging

deny contains msg if {
	some m in of_type("aws_sfn_state_machine")
	object.get(after(m), ["logging_configuration", 0, "include_execution_data"], true) != false
	msg := sprintf("SFN-LOGS: %s must set include_execution_data = false", [m.address])
}

deny contains msg if {
	some m in of_type("aws_sfn_state_machine")
	object.get(after(m), ["logging_configuration", 0, "level"], "OFF") == "OFF"
	msg := sprintf("SFN-LOGS: %s must log at ERROR, FATAL or ALL", [m.address])
}

deny contains msg if {
	some m in of_type("aws_sfn_state_machine")
	after(m).type != "STANDARD"
	msg := sprintf("SFN-TYPE: %s must be a STANDARD workflow", [m.address])
}

# ---------------------------------------------------------------- 8. no PHI-like content in names and alert text

phi_like := `[0-9]{3}-[0-9]{3}-[0-9]{4}|[0-9]{3}-[0-9]{2}-[0-9]{4}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`

named_fields := ["name", "bucket", "alarm_name", "alarm_description", "dashboard_name", "family", "description", "cluster_identifier", "identifier"]

deny contains msg if {
	some r in planned
	some f in named_fields
	v := object.get(after(r), f, null)
	is_string(v)
	regex.match(phi_like, v)
	msg := sprintf("NAMING: %s.%s contains phone/SSN/email-like content (no PHI in names or alert text)", [r.address, f])
}

# ---------------------------------------------------------------- 9. IAM wildcards (where known at plan time)

deny contains msg if {
	some t in {"aws_iam_role_policy", "aws_iam_policy"}
	some p in of_type(t)
	is_string(after(p).policy)
	doc := json.unmarshal(after(p).policy)
	some st in doc.Statement
	st.Effect == "Allow"
	"*" in as_list(st.Action)
	msg := sprintf("IAM: %s allows Action \"*\"", [p.address])
}

deny contains msg if {
	some r in of_type("aws_iam_role")
	is_string(after(r).assume_role_policy)
	doc := json.unmarshal(after(r).assume_role_policy)
	some st in doc.Statement
	st.Effect == "Allow"
	public_principal(st.Principal)
	msg := sprintf("IAM: %s trust policy admits any principal", [r.address])
}

deny contains msg if {
	some r in of_type("aws_iam_role")
	is_string(after(r).assume_role_policy)
	doc := json.unmarshal(after(r).assume_role_policy)
	some st in doc.Statement
	contains(object.get(object.get(st, "Principal", {}), "Federated", ""), "token.actions.githubusercontent.com")
	not exact_github_subject(st)
	msg := sprintf("IAM: %s GitHub OIDC trust must pin aud and an exact repo:environment subject", [r.address])
}

exact_github_subject(st) if {
	eq := st.Condition.StringEquals
	eq["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
	sub := eq["token.actions.githubusercontent.com:sub"]
	startswith(sub, "repo:")
	contains(sub, ":environment:")
	not contains(sub, "*")
}

as_list(x) := x if is_array(x)

as_list(x) := [x] if is_string(x)

# ---------------------------------------------------------------- summary

summary := {
	"resources_planned": count(planned),
	"violations": count(deny),
	"result": result,
}

result := "PASS" if count(deny) == 0

result := "FAIL" if count(deny) > 0
