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
	msg := sprintf("IAM: %s GitHub OIDC trust must pin aud and an exact repo:environment:job_workflow_ref subject (one workflow file on one branch)", [r.address])
}

# The customized GitHub subject (repo, context, job_workflow_ref): the environment alone can be
# claimed by a job on any branch; the workflow file at an exact branch ref cannot (VSP-INF-03).
exact_github_subject(st) if {
	eq := st.Condition.StringEquals
	eq["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
	sub := eq["token.actions.githubusercontent.com:sub"]
	startswith(sub, "repo:")
	contains(sub, ":environment:")
	regex.match(`:job_workflow_ref:[^:@*]+/\.github/workflows/[^:@*/]+@refs/heads/[^:@*]+$`, sub)
	not contains(sub, "*")
}

as_list(x) := x if is_array(x)

as_list(x) := [x] if is_string(x)

# ---------------------------------------------------------------- 10. WAF log redaction (VSP-INF-01)

# WAF logs every request header; each header that carries a credential, a bearer session
# reference, the call binding or a caller-chosen token must be redacted (exact lowercase
# names, as WAF requires).
waf_required_redacted_headers := {"authorization", "cookie", "mcp-session-id", "x-vsp-session-ref", "x-vsp-interaction-id", "idempotency-key"}

waf_redacted_headers(c) := {h.name |
	some f in object.get(after(c), "redacted_fields", [])
	some h in object.get(f, "single_header", [])
}

deny contains msg if {
	some c in of_type("aws_wafv2_web_acl_logging_configuration")
	missing := waf_required_redacted_headers - waf_redacted_headers(c)
	count(missing) > 0
	msg := sprintf("WAF-LOGS: %s must redact %v (credentials and bearer references never reach WAF logs)", [c.address, sort(missing)])
}

deny contains msg if {
	some c in of_type("aws_wafv2_web_acl_logging_configuration")
	not waf_query_string_redacted(c)
	msg := sprintf("WAF-LOGS: %s must redact the query string", [c.address])
}

waf_query_string_redacted(c) if {
	some f in object.get(after(c), "redacted_fields", [])
	count(object.get(f, "query_string", [])) > 0
}

# ---------------------------------------------------------------- 11. CI identity (VSP-INF-02, VSP-INF-03)

# Minimal IAM evaluator used to probe rendered policy documents (same-account semantics: an
# explicit Deny wins; Action/NotAction, Resource/NotResource, String*/Arn* conditions with
# AWS absent-key semantics). An unsupported condition operator never matches, so a Deny that
# uses one is treated as not applying: the probe then reports the path as open (fail closed).

iam_statements(doc) := doc.Statement if is_array(doc.Statement)

iam_statements(doc) := [doc.Statement] if is_object(doc.Statement)

iam_explicit_deny(doc, action, resource, ctx) if {
	some st in iam_statements(doc)
	st.Effect == "Deny"
	iam_applies(st, action, resource, ctx)
}

iam_allows(doc, action, resource, ctx) if {
	not iam_explicit_deny(doc, action, resource, ctx)
	some st in iam_statements(doc)
	st.Effect == "Allow"
	iam_applies(st, action, resource, ctx)
}

iam_applies(st, action, resource, ctx) if {
	iam_action_in(st, action)
	iam_resource_in(st, resource)
	iam_conditions_hold(object.get(st, "Condition", {}), ctx)
}

# IAM action names are case-insensitive; resources are not. `null` = no glob delimiters.
iam_action_in(st, action) if {
	some p in as_list(object.get(st, "Action", []))
	glob.match(lower(p), null, lower(action))
}

iam_action_in(st, action) if {
	not_actions := as_list(st.NotAction)
	not iam_any_action(not_actions, action)
}

iam_any_action(patterns, action) if {
	some p in patterns
	glob.match(lower(p), null, lower(action))
}

iam_resource_in(st, resource) if {
	some p in as_list(object.get(st, "Resource", []))
	glob.match(p, null, resource)
}

iam_resource_in(st, resource) if {
	not_resources := as_list(st.NotResource)
	not iam_any_resource(not_resources, resource)
}

iam_any_resource(patterns, resource) if {
	some p in patterns
	glob.match(p, null, resource)
}

iam_conditions_hold(cond, ctx) if {
	every op, kv in cond {
		every key, vals in kv {
			iam_condition(op, object.get(ctx, key, null), as_list(vals))
		}
	}
}

# Operator -> whether its values are wildcard patterns.
iam_positive_ops := {"StringEquals": false, "StringLike": true, "ArnEquals": true, "ArnLike": true}

iam_negated_ops := {"StringNotEquals": false, "StringNotLike": true, "ArnNotEquals": true, "ArnNotLike": true}

iam_condition(op, have, vals) if {
	wild := iam_positive_ops[op]
	have != null
	iam_value_matches(wild, have, vals)
}

# A negated operator holds when the key is absent from the request.
iam_condition(op, have, _) if {
	op in object.keys(iam_negated_ops)
	have == null
}

iam_condition(op, have, vals) if {
	wild := iam_negated_ops[op]
	have != null
	not iam_value_matches(wild, have, vals)
}

iam_value_matches(false, have, vals) if have in vals

# Bool compares "true"/"false" case-insensitively; an absent key does not hold. BoolIfExists also
# holds when the key is absent (the request does not carry it).
iam_condition("Bool", have, vals) if iam_bool_matches(have, vals)

iam_condition("BoolIfExists", have, _) if have == null

iam_condition("BoolIfExists", have, vals) if iam_bool_matches(have, vals)

iam_bool_matches(have, vals) if {
	have != null
	lower(sprintf("%v", [have])) in {lower(sprintf("%v", [v])) | some v in vals}
}

iam_value_matches(true, have, vals) if {
	some v in vals
	glob.match(v, null, have)
}

# The CI permissions boundary (modules/iam_ci): known at plan time, so its effect is probed
# directly. It must explicitly deny every probed path by which code running with the CI
# credentials could rewrite the CI identity, escalate through another principal, read data,
# or export or share it with the calls the stack never makes (VSP-INF-02). Resource policies
# Terraform itself manages are not probed: IAM cannot inspect their content (README residual risk).
ci_boundaries := {p |
	some p in of_type("aws_iam_policy")
	endswith(object.get(after(p), "name", ""), "-ci-boundary")
	is_string(after(p).policy)
}

ci_boundary_arns(doc) := {arn |
	some st in iam_statements(doc)
	st.Effect == "Deny"
	some arn in as_list(st.Condition.StringNotEquals["iam:PermissionsBoundary"])
}

ci_probe_region(doc) := r if {
	regions := {x |
		some st in iam_statements(doc)
		some x in as_list(st.Condition.StringNotEquals["aws:RequestedRegion"])
	}
	r := sort(regions)[0]
} else := "us-east-1"

ci_self_change_actions := {
	"iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
	"iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:PassRole",
}

ci_foreign_role_actions := {"iam:AttachRolePolicy", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PassRole"}

ci_data_plane_probe_actions := {"dynamodb:GetItem", "dynamodb:Scan", "secretsmanager:GetSecretValue", "sqs:ReceiveMessage", "logs:FilterLogEvents", "kms:Decrypt"}

# Calls that copy data out or share it under the caller's own authorization; the stack never makes them.
# Object ACLs (s3:PutObjectAcl, s3:PutObjectVersionAcl) can grant another account read access to a
# single object (or one version of it), so they are probed like the bucket ACL.
ci_data_export_probe_actions := {
	"dynamodb:ExportTableToPointInTime", "dynamodb:PutResourcePolicy", "rds:ModifyDBClusterSnapshotAttribute", "rds:ModifyDBSnapshotAttribute",
	"rds:StartExportTask", "logs:CreateExportTask", "logs:PutSubscriptionFilter", "s3:PutReplicationConfiguration", "s3:PutBucketAcl",
	"s3:PutObjectAcl", "s3:PutObjectVersionAcl", "sqs:AddPermission",
}

# The resource an export probe names, as IAM authorizes the call: an object for the object-level
# S3 calls, the bucket for every other S3 call (bucket ACL, replication), a table otherwise. A
# deny scoped to the wrong resource type (objects only for a bucket call, or the reverse) does
# not stop the call and is reported.
ci_s3_object_probe_actions := {"s3:PutObjectAcl", "s3:PutObjectVersionAcl"}

ci_export_probe_resource(part, _, _, a) := sprintf("arn:%s:s3:::probe-bucket/probe-object", [part]) if a in ci_s3_object_probe_actions

ci_export_probe_resource(part, _, _, a) := sprintf("arn:%s:s3:::probe-bucket", [part]) if {
	startswith(a, "s3:")
	not a in ci_s3_object_probe_actions
}

ci_export_probe_resource(part, region, acct, a) := sprintf("arn:%s:dynamodb:%s:%s:table/probe", [part, region, acct]) if not startswith(a, "s3:")

# Every bucket the boundary itself names in a Resource or NotResource (wildcards instantiated). The
# object-ACL calls are probed on an object in each of them as well, so a deny that exempts one
# bucket's objects (for example NotResource on the Terraform state's objects) is reported for it;
# the generic probe object alone would not see such an exemption.
ci_boundary_named_buckets(doc) := {b |
	some st in iam_statements(doc)
	some key in ["Resource", "NotResource"]
	some r in as_list(object.get(st, key, []))
	is_string(r)
	some m in regex.find_all_string_submatch_n(`^arn:[a-z-]+:s3:::([^/]+)`, r, 1)
	b := strings.replace_n({"*": "probe", "?": "p"}, m[1])
}

# Sharing calls Terraform does make: probed without the request keys that would scope them
# (kms:GrantIsForAWSResource, secretsmanager:BlockPublicPolicy), as a direct call would be.
ci_scoped_share_probe_actions := {"kms:CreateGrant", "secretsmanager:PutResourcePolicy"}

ci_account_level_actions := {"iam:CreateOpenIDConnectProvider", "iam:CreateAccessKey", "iam:AttachGroupPolicy", "iam:CreatePolicyVersion"}

ci_probes(part, acct, prefix, boundary, region, buckets) := ((((((self_p | foreign_p) | assume_p) | data_p) | export_p) | object_acl_p) | share_p) | account_p if {
	roles := {sprintf("arn:%s:iam::%s:role/%s-gha-plan", [part, acct, prefix]), sprintf("arn:%s:iam::%s:role/%s-gha-apply", [part, acct, prefix])}
	foreign := sprintf("arn:%s:iam::%s:role/PreExistingAdministratorRole", [part, acct])
	self_p := {{"desc": sprintf("%s on its own role %s", [a, r]), "action": a, "resource": r, "ctx": {"aws:RequestedRegion": region, "iam:PermissionsBoundary": boundary}} |
		some r in roles
		some a in ci_self_change_actions
	}
	foreign_p := {{"desc": sprintf("%s on a role CI did not create", [a]), "action": a, "resource": foreign, "ctx": {"aws:RequestedRegion": region}} |
		some a in ci_foreign_role_actions
	}
	assume_p := {{"desc": "sts:AssumeRole into an in-account role", "action": "sts:AssumeRole", "resource": foreign, "ctx": {"aws:RequestedRegion": region}}}
	data_p := {{"desc": sprintf("%s by CI role %s", [a, r]), "action": a, "resource": sprintf("arn:%s:dynamodb:%s:%s:table/probe", [part, region, acct]), "ctx": {"aws:RequestedRegion": region, "aws:PrincipalArn": r, "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::not-the-state-bucket/object"}} |
		some r in roles
		some a in ci_data_plane_probe_actions
	}
	export_p := {{"desc": sprintf("%s (export or share) by CI role %s", [a, r]), "action": a, "resource": ci_export_probe_resource(part, region, acct, a), "ctx": {"aws:RequestedRegion": region, "aws:PrincipalArn": r}} |
		some r in roles
		some a in ci_data_export_probe_actions
	}
	object_acl_p := {{"desc": sprintf("%s (export or share) by CI role %s on %s", [a, r, res]), "action": a, "resource": res, "ctx": {"aws:RequestedRegion": region, "aws:PrincipalArn": r}} |
		some r in roles
		some a in ci_s3_object_probe_actions
		some b in buckets
		res := sprintf("arn:%s:s3:::%s/probe-object", [part, b])
	}
	share_p := {{"desc": sprintf("%s outside an AWS-service grant or a non-public policy by CI role %s", [a, r]), "action": a, "resource": "*", "ctx": {"aws:RequestedRegion": region, "aws:PrincipalArn": r}} |
		some r in roles
		some a in ci_scoped_share_probe_actions
	}
	account_p := {{"desc": a, "action": a, "resource": "*", "ctx": {"aws:RequestedRegion": region}} |
		some a in ci_account_level_actions
	}
}

ci_escalations(doc) := {probe.desc |
	some arn in ci_boundary_arns(doc)
	m := regex.find_all_string_submatch_n(`^arn:([a-z-]+):iam::([0-9]{12}):policy/(.+)-ci-boundary$`, arn, 1)[0]
	some probe in ci_probes(m[1], m[2], m[3], arn, ci_probe_region(doc), ci_boundary_named_buckets(doc))
	iam_allows(doc, probe.action, probe.resource, probe.ctx)
}

deny contains msg if {
	some p in ci_boundaries
	count(ci_boundary_arns(json.unmarshal(after(p).policy))) == 0
	msg := sprintf("CI-BOUNDARY: %s must require itself (iam:PermissionsBoundary) on every role CI creates or changes", [p.address])
}

deny contains msg if {
	some p in ci_boundaries
	some e in ci_escalations(json.unmarshal(after(p).policy))
	msg := sprintf("CI-BOUNDARY: %s allows %s (CI must not change its own identity, read, export or share data, or escalate through other roles)", [p.address, e])
}

# Terraform state: plan writes only the lock; apply never deletes the state (VSP-INF-03).
ci_role_policies(policy_name, role_suffix) := {p |
	some p in of_type("aws_iam_role_policy")
	ci_role_policy(p, policy_name, role_suffix)
}

ci_role_policy(p, policy_name, _) if after(p).name == policy_name

ci_role_policy(p, _, role_suffix) if {
	role := object.get(after(p), "role", "")
	is_string(role)
	endswith(role, role_suffix)
}

# An allowed write or delete on anything but a lock, not cancelled by an explicit deny in the
# same policy (the role cannot rewrite it). The probe object stands for the state file.
ci_state_writes(p, actions) := {sprintf("%s on %s", [a, r]) |
	is_string(after(p).policy)
	doc := json.unmarshal(after(p).policy)
	some st in iam_statements(doc)
	st.Effect == "Allow"
	some a in actions
	iam_action_in(st, a)
	some r in as_list(object.get(st, "Resource", ["*"]))
	not endswith(r, ".tflock")
	not iam_explicit_deny(doc, a, ci_state_probe(r), {})
}

ci_state_probe("*") := "arn:aws:s3:::any-bucket/terraform.tfstate"

ci_state_probe(r) := concat("", [trim_suffix(r, "*"), "terraform.tfstate"]) if {
	r != "*"
	endswith(r, "*")
}

ci_state_probe(r) := r if not endswith(r, "*")

deny contains msg if {
	some p in ci_role_policies("state-and-data-plane-deny", "-gha-plan")
	some w in ci_state_writes(p, ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"])
	msg := sprintf("CI-STATE: %s lets the plan role %s (terraform plan writes only the .tflock)", [p.address, w])
}

deny contains msg if {
	some p in ci_role_policies("deploy-within-boundary", "-gha-apply")
	some w in ci_state_writes(p, ["s3:DeleteObject", "s3:DeleteObjectVersion"])
	msg := sprintf("CI-STATE: %s lets the apply role %s (it may delete only the .tflock)", [p.address, w])
}

# CI cannot change its own identity (the boundary denies it); a plan that would is refused
# here, before a partial apply. Creation (bootstrap, offline plans) is not a change.
ci_identity_types := {"aws_iam_role", "aws_iam_role_policy", "aws_iam_policy", "aws_iam_role_policy_attachment", "aws_iam_openid_connect_provider"}

deny contains msg if {
	some rc in input.resource_changes
	rc.type in ci_identity_types
	regex.match(`(^|\.)module\.iam_ci(\[[0-9]+\])?$`, module_of(rc))
	some action in rc.change.actions
	action in {"update", "delete"}
	msg := sprintf("CI-IDENTITY: %s would be changed by CI; changes to the CI identity are applied by an account administrator", [rc.address])
}

# ---------------------------------------------------------------- 12. edge rate limits never block the safety routes (SAFE-02, SAFE-03)

# Request paths of the safety and human-route calls: the MCP tools request_safety_route and
# request_human_transfer, and Studio telephony control (utterance screening, human request,
# handoff). WAF cannot tell these calls apart from the other Talkdesk calls on the same paths and
# source IPs, so a rate-based rule that can stop a call (any action but Count, see waf_blocks) must
# provably not apply to any of them; the ingress module counts them instead (ADR-0012).
waf_safety_route_paths := {"/mcp", "/mcp/", "/telephony/v1/session/utterance-screening", "/telephony/v1/session/human-request", "/telephony/v1/session/handoff"}

# Web ACLs, and custom rule groups (a web ACL can reference their rules), are checked alike.
waf_rule_sets := of_type("aws_wafv2_web_acl") | of_type("aws_wafv2_rule_group")

# rule_json is unknown at plan time when it references a computed IP set ARN (the plan that creates
# the supplemental allowlist): the gate cannot see the rules then, and that configuration is
# covered by the ingress module's terraform test (infra/terraform/README.md, residual risk).
waf_acl_rules(acl) := rules if {
	raw := object.get(after(acl), "rule_json", null)
	is_string(raw)
	rules := json.unmarshal(raw)
	is_array(rules)
}

# Only a Count action is known never to stop a call. Block refuses the call, and Captcha and Challenge
# answer a non-browser client (Talkdesk's MCP client, Studio's HTTP steps) with a puzzle or an
# interstitial it cannot solve, which stops the call as surely. Allow, a missing action or any
# other value is refused rather than reasoned about (fail closed).
waf_blocks(rule) if not waf_count_only(rule)

waf_count_only(rule) if {
	action := object.get(rule, "Action", null)
	is_object(action)
	object.keys(action) == {"Count"}
}

deny contains msg if {
	some acl in waf_rule_sets
	some rule in waf_acl_rules(acl)
	waf_blocks(rule)
	rate := rule.Statement.RateBasedStatement
	some path in waf_safety_route_paths
	waf_scope_may_match(rate, path)
	msg := sprintf("WAF-RATE: %s rule %s can rate-block %s (safety and human-route calls); scope the blocking rule to other paths and count these instead", [acl.address, rule.Name, path])
}

# A rate-based rule with any action, Count included, labels the requests it counts once its limit is
# exceeded (RuleLabels), and a later rule can block on that label (LabelMatchStatement): together they
# rate-block as surely as a blocking rate rule. The gate does not follow label keys, namespaces or rule
# priorities, so it refuses the pair whenever the labelling rule can match a safety-route path (fail closed).
deny contains msg if {
	some acl in waf_rule_sets
	rules := waf_acl_rules(acl)
	some labeller in rules
	waf_emits_labels(labeller)
	rate := labeller.Statement.RateBasedStatement
	some path in waf_safety_route_paths
	waf_scope_may_match(rate, path)
	some blocker in rules
	waf_blocks(blocker)
	waf_matches_labels(blocker)
	msg := sprintf("WAF-RATE: %s rule %s blocks on labels and rate-based rule %s labels requests that can be %s (a rate block through labels); do not label those requests, or block only on labels no rate-based rule emits", [acl.address, blocker.Name, labeller.Name, path])
}

# A custom rule group can hold rate-based rules too, and the gate does not evaluate its rules: a
# reference whose rule actions apply (any OverrideAction but Count) is refused (fail closed). AWS
# managed rule groups are not evaluated either (infra/terraform/README.md, residual risk).
deny contains msg if {
	some acl in of_type("aws_wafv2_web_acl")
	some rule in waf_acl_rules(acl)
	waf_has_statement(rule, "RuleGroupReferenceStatement")
	not waf_override_count(rule)
	msg := sprintf("WAF-RATE: %s rule %s references a custom rule group, whose rules (rate-based rules included) this gate does not evaluate; reference it with OverrideAction Count, or declare its rules in the web ACL", [acl.address, rule.Name])
}

# The gate reads rule_json only; rules declared as `rule {}` blocks would bypass it.
deny contains msg if {
	some acl in waf_rule_sets
	not waf_empty(object.get(after(acl), "rule", []))
	msg := sprintf("WAF-RATE: %s declares rule blocks, which this gate does not evaluate; declare its rules in rule_json", [acl.address])
}

waf_empty(x) if x == null

waf_empty(x) if x == []

waf_emits_labels(rule) if not waf_empty(object.get(rule, "RuleLabels", []))

waf_matches_labels(rule) if waf_has_statement(rule, "LabelMatchStatement")

waf_has_statement(rule, kind) if {
	walk(object.get(rule, "Statement", {}), [_, node])
	is_object(node)
	object.get(node, kind, null) != null
}

waf_override_count(rule) if {
	override := object.get(rule, "OverrideAction", null)
	is_object(override)
	object.keys(override) == {"Count"}
}

waf_scope_may_match(rate, _) if not rate.ScopeDownStatement

waf_scope_may_match(rate, path) if waf_may4(rate.ScopeDownStatement, path)

# Three-valued evaluation of a statement for a request that differs only in its URI path. A
# RegexMatchStatement on the untransformed URI path is decided exactly, but only when its pattern
# is portable (waf_portable_regex): AWS WAF accepts PCRE constructs RE2 rejects (lookaround,
# backreferences), and a pattern RE2 compiles can still match differently in PCRE, so any other
# pattern is unknown here, never "does not match". Every other leaf, and nesting deeper than four
# levels, is unknown too. `may` over-approximates and `must`
# under-approximates, so a blocking rule passes only if it provably excludes every safety-route
# path (fail closed).
waf_composite(st) if st.NotStatement

waf_composite(st) if st.OrStatement

waf_composite(st) if st.AndStatement

waf_exact_leaf(st) if {
	rm := st.RegexMatchStatement
	is_string(rm.RegexString)
	waf_portable_regex(rm.RegexString)
	object.keys(rm.FieldToMatch) == {"UriPath"}
	count(rm.TextTransformations) > 0
	every t in rm.TextTransformations {
		t.Type == "NONE"
	}
}

# The subset in which RE2 (OPA) and AWS WAF's PCRE agree on the fixed ASCII probe paths: a pattern
# RE2 compiles, of printable ASCII, with "(?" only as the non-capturing "(?:" (no inline flags,
# lookaround or named groups) and no backslash before a letter or digit (no class escapes such as
# \s, \w, \b or \p{..}, no \Q..\E). Outside it RE2 can match differently: under (?i) it folds U+017F
# (long s) to "s", which PCRE matching byte-wise does not, so an exclusion would hold in OPA only.
waf_portable_regex(re) if {
	regex.is_valid(re)
	regex.match(`^[ -~]*$`, re)
	not regex.match(`\(\?[^:]`, re)
	not regex.match(`\\[0-9A-Za-z]`, re)
}

waf_leaf_may(st, _) if {
	not waf_composite(st)
	not waf_exact_leaf(st)
}

waf_leaf_may(st, path) if {
	waf_exact_leaf(st)
	regex.match(st.RegexMatchStatement.RegexString, path)
}

waf_leaf_must(st, path) if {
	waf_exact_leaf(st)
	regex.match(st.RegexMatchStatement.RegexString, path)
}

waf_may1(st, path) if waf_leaf_may(st, path)

waf_may1(st, _) if waf_composite(st)

waf_must1(st, path) if waf_leaf_must(st, path)

waf_may2(st, path) if waf_leaf_may(st, path)

waf_may2(st, path) if {
	inner := st.NotStatement.Statement
	not waf_must1(inner, path)
}

waf_may2(st, path) if {
	some c in st.OrStatement.Statements
	waf_may1(c, path)
}

waf_may2(st, path) if {
	cs := st.AndStatement.Statements
	every c in cs {
		waf_may1(c, path)
	}
}

waf_must2(st, path) if waf_leaf_must(st, path)

waf_must2(st, path) if {
	inner := st.NotStatement.Statement
	not waf_may1(inner, path)
}

waf_must2(st, path) if {
	some c in st.OrStatement.Statements
	waf_must1(c, path)
}

waf_must2(st, path) if {
	cs := st.AndStatement.Statements
	every c in cs {
		waf_must1(c, path)
	}
}

waf_may3(st, path) if waf_leaf_may(st, path)

waf_may3(st, path) if {
	inner := st.NotStatement.Statement
	not waf_must2(inner, path)
}

waf_may3(st, path) if {
	some c in st.OrStatement.Statements
	waf_may2(c, path)
}

waf_may3(st, path) if {
	cs := st.AndStatement.Statements
	every c in cs {
		waf_may2(c, path)
	}
}

waf_must3(st, path) if waf_leaf_must(st, path)

waf_must3(st, path) if {
	inner := st.NotStatement.Statement
	not waf_may2(inner, path)
}

waf_must3(st, path) if {
	some c in st.OrStatement.Statements
	waf_must2(c, path)
}

waf_must3(st, path) if {
	cs := st.AndStatement.Statements
	every c in cs {
		waf_must2(c, path)
	}
}

waf_may4(st, path) if waf_leaf_may(st, path)

waf_may4(st, path) if {
	inner := st.NotStatement.Statement
	not waf_must3(inner, path)
}

waf_may4(st, path) if {
	some c in st.OrStatement.Statements
	waf_may3(c, path)
}

waf_may4(st, path) if {
	cs := st.AndStatement.Statements
	every c in cs {
		waf_may3(c, path)
	}
}

# ---------------------------------------------------------------- 13. KMS grants in key policies

# An IAM principal (key administrators, the account root that delegates to IAM policies, or
# "*") may create grants only for AWS resources. Matching uses the evaluator's action globs,
# so kms:Create* or a NotAction that leaves kms:CreateGrant in counts, and the statement must
# carry a Bool kms:GrantIsForAWSResource condition that holds for "true" and not for "false".
# Other conditions do not count (fail closed). Service principals (e.g. Fargate) are not IAM principals.
deny contains msg if {
	some k in of_type("aws_kms_key")
	is_string(after(k).policy)
	some st in iam_statements(json.unmarshal(after(k).policy))
	st.Effect == "Allow"
	kms_iam_principal(st.Principal)
	iam_action_in(st, "kms:CreateGrant")
	not kms_grant_for_aws_resources_only(st)
	msg := sprintf("KMS-GRANT: %s statement %s lets an IAM principal create grants that are not for AWS resources (needs Bool kms:GrantIsForAWSResource = true; kms:Create* matches kms:CreateGrant)", [k.address, object.get(st, "Sid", "(no Sid)")])
}

kms_iam_principal("*")

kms_iam_principal(p) if {
	is_object(p)
	"AWS" in object.keys(p)
}

kms_grant_for_aws_resources_only(st) if {
	vals := kms_condition_values(st.Condition.Bool["kms:GrantIsForAWSResource"])
	iam_condition("Bool", "true", vals)
	not iam_condition("Bool", "false", vals)
}

kms_condition_values(x) := x if is_array(x)

kms_condition_values(x) := [x] if not is_array(x)

# ---------------------------------------------------------------- summary

summary := {
	"resources_planned": count(planned),
	"violations": count(deny),
	"result": result,
}

result := "PASS" if count(deny) == 0

result := "FAIL" if count(deny) > 0
