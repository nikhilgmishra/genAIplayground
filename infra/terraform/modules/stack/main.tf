# Per-environment composition of the platform modules. Environment roots
# (infra/terraform/envs/*) configure providers/backends and pass tfvars here.
# Nothing in this repository is applied by the coding agent (OPS-05): plans run
# in CI only after a scoped approval, behind protected GitHub environments.

locals {
  is_dr = var.deployment_role == "dr"

  role_arn = { for r in ["gateway-task", "worker-task", "ecs-execution", "workflows", "gha-apply"] :
  r => "arn:${var.partition}:iam::${var.workload_account_id}:role/${var.name_prefix}-${r}" }

  key_admins = distinct(concat(var.key_admin_role_arns, var.ci.manage ? [local.role_arn["gha-apply"]] : []))

  cluster_name = "${var.name_prefix}-cluster"

  base_tags = merge(var.tags, {
    "vsp:environment"     = var.environment
    "vsp:deployment-role" = var.deployment_role
  })

  # Integration credentials (adapter keys match DEPENDENCY_IDS in
  # platform/src/observability/metrics.ts). Containers only; owners load values.
  secret_defs = {
    salesforce             = { owner = "salesforce_admin", readers = ["gateway", "worker"], description = "Salesforce integration identity (OAuth client)" }
    talkdesk-telephony     = { owner = "talkdesk_admin", readers = ["gateway"], description = "Talkdesk telephony-control API client" }
    oidc-client-idp        = { owner = "identity_owner", readers = ["gateway"], description = "Client IdP OIDC test/live client" }
    oidc-provider-idp      = { owner = "identity_owner", readers = ["gateway"], description = "Provider IdP OIDC client" }
    workforce-sso          = { owner = "identity_owner", readers = ["gateway"], description = "Workforce SSO client for the console API" }
    identity-directory     = { owner = "identity_owner", readers = ["gateway"], description = "Restricted verification directory client" }
    relationship-directory = { owner = "identity_owner", readers = ["gateway"], description = "Enrollment / delegation registry client" }
    scheduling             = { owner = "business_system_owner", readers = ["gateway", "worker"], description = "Scheduling API client" }
    billing                = { owner = "business_system_owner", readers = ["gateway", "worker"], description = "Billing API client" }
    claims                 = { owner = "business_system_owner", readers = ["gateway", "worker"], description = "Claims API client" }
    provider-system        = { owner = "business_system_owner", readers = ["gateway", "worker"], description = "Provider system API client" }
    notifications          = { owner = "support_operations", readers = ["worker"], description = "Notification provider client (neutral messages only)" }
  }

  queue_defs = {
    crm-sync        = { fifo = true, visibility_timeout_seconds = 120, max_receive_count = 5, outbox_topics = ["support_request.sync"] }
    workflow-events = { fifo = true, visibility_timeout_seconds = 120, max_receive_count = 5, outbox_topics = ["workflow.start", "workflow.signal"] }
    audit-ship      = { fifo = true, visibility_timeout_seconds = 120, max_receive_count = 5, outbox_topics = ["audit.ship"] }
    notifications   = { fifo = false, visibility_timeout_seconds = 60, max_receive_count = 5, outbox_topics = ["notification.send"] }
    action-events   = { fifo = false, visibility_timeout_seconds = 60, max_receive_count = 5, outbox_topics = ["action.committed"] }
    # Step Functions work-item queues (contract: infra/stepfunctions/README.md). Standard
    # queues: the generated ASL sends without MessageGroupId; the worker deduplicates.
    wf-system-tasks = { fifo = false, visibility_timeout_seconds = 300, max_receive_count = 5, outbox_topics = [] }
    wf-human-tasks  = { fifo = false, visibility_timeout_seconds = 300, max_receive_count = 5, outbox_topics = [] }
    wf-notify       = { fifo = false, visibility_timeout_seconds = 300, max_receive_count = 5, outbox_topics = [] }
    wf-escalation   = { fifo = false, visibility_timeout_seconds = 300, max_receive_count = 5, outbox_topics = [] }
    wf-recheck      = { fifo = false, visibility_timeout_seconds = 300, max_receive_count = 5, outbox_topics = [] }
  }

  # templatefile() placeholders used by the generated ASL -> queue key.
  workflow_queue_placeholders = {
    system_task_queue_url = "wf-system-tasks"
    human_task_queue_url  = "wf-human-tasks"
    notify_queue_url      = "wf-notify"
    escalation_queue_url  = "wf-escalation"
    recheck_queue_url     = "wf-recheck"
  }

  sessions_table_name = var.sessions.create ? module.dynamodb_sessions[0].table_name : var.sessions.existing_table_name
  sessions_table_arn  = var.sessions.create ? module.dynamodb_sessions[0].table_arn : "arn:${var.partition}:dynamodb:${var.region}:${var.workload_account_id}:table/${var.sessions.existing_table_name}"
  sessions_kms_key    = var.sessions.create ? module.kms.key_arns["sessions"] : var.sessions.replica_kms_key_arn

  audit_bucket_name     = var.audit.managed_here ? module.audit[0].bucket_name : var.audit.existing_bucket_name
  audit_writer_role_arn = var.audit.managed_here ? module.audit[0].writer_role_arn : var.audit.existing_writer_role_arn

  secret_refs = {
    for svc in ["gateway", "worker"] : svc => {
      for k, s in local.secret_defs : k => module.secrets.secret_arns[k] if contains(s.readers, svc)
    }
  }

  db_user_arn = "arn:${var.partition}:rds-db:${var.region}:${var.workload_account_id}:dbuser:${module.aurora.cluster_resource_id}/app_runtime"

  metrics_statements = [
    {
      Sid       = "PublishPlatformMetricsNamespaceOnly"
      Effect    = "Allow"
      Action    = ["cloudwatch:PutMetricData"]
      Resource  = "*"
      Condition = { StringEquals = { "cloudwatch:namespace" = "VSP" } }
    },
    {
      Sid      = "EmbeddedMetricLogs"
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["arn:${var.partition}:logs:${var.region}:${var.workload_account_id}:log-group:/vsp/${var.name_prefix}/metrics:*"]
    },
  ]

  gateway_policy = jsonencode({ Version = "2012-10-17", Statement = local.gateway_statements })
  worker_policy  = jsonencode({ Version = "2012-10-17", Statement = local.worker_statements })

  gateway_statements = concat(
    [
      {
        Sid      = "SessionTableConditionalWrites"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"]
        Resource = [local.sessions_table_arn]
      },
      {
        Sid      = "LedgerIamAuthentication"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = [local.db_user_arn]
      },
      {
        Sid      = "ReadOwnIntegrationSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = values(local.secret_refs["gateway"])
      },
      {
        Sid      = "UseOwnKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = compact([local.sessions_kms_key, module.kms.key_arns["secrets"]])
      },
    ],
    local.metrics_statements,
  )

  worker_statements = concat(
    [
      {
        Sid    = "OutboxDeliveryAndConsumption"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
        ]
        Resource = concat(values(module.sqs.queue_arns), values(module.sqs.dlq_arns))
      },
      {
        Sid    = "DurableWorkflows"
        Effect = "Allow"
        Action = [
          "states:StartExecution", "states:DescribeExecution", "states:StopExecution",
          "states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat",
        ]
        Resource = [
          "${module.step_functions.state_machine_arn_prefix}*",
          "arn:${var.partition}:states:${var.region}:${var.workload_account_id}:execution:${var.name_prefix}-*:*",
        ]
      },
      {
        Sid      = "LedgerIamAuthentication"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = [local.db_user_arn]
      },
      {
        Sid      = "ReadOwnIntegrationSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = values(local.secret_refs["worker"])
      },
      {
        Sid      = "UseOwnKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [module.kms.key_arns["messaging"], module.kms.key_arns["workflows"], module.kms.key_arns["secrets"]]
      },
      {
        Sid      = "AssumeWriteOnlyAuditShipperRole"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = [local.audit_writer_role_arn]
      },
    ],
    local.metrics_statements,
  )

  common_env = {
    PORT                   = "8080"
    VSP_DEPLOYMENT_ROLE    = var.deployment_role
    VSP_SESSION_TABLE      = local.sessions_table_name
    VSP_DB_WRITER_ENDPOINT = module.aurora.writer_endpoint
    VSP_DB_READER_ENDPOINT = module.aurora.reader_endpoint
    VSP_DB_NAME            = "vsp"
    VSP_DB_IAM_USER        = "app_runtime"
    VSP_METRICS_NAMESPACE  = "VSP"
    VSP_METRICS_LOG_GROUP  = "/vsp/${var.name_prefix}/metrics"
  }
}

resource "terraform_data" "stack_guards" {
  input = var.deployment_role

  lifecycle {
    precondition {
      condition     = !local.is_dr || var.environment == "production"
      error_message = "Only production has a DR stack."
    }
    precondition {
      condition     = !local.is_dr || !var.mutations_enabled || var.failover_change_ref != null
      error_message = "Mutations in the DR region require failover_change_ref (a reviewed failover decision); the default is the write fence."
    }
    precondition {
      condition     = !local.is_dr || !var.sessions.create
      error_message = "The DR stack uses the primary's global-table replica; it never creates a second session table."
    }
    precondition {
      condition     = var.workload_account_id != var.audit_account_id
      error_message = "The audit account must be separate from the workload account."
    }
    precondition {
      condition     = var.sessions.create || (var.sessions.existing_table_name != null && var.sessions.replica_kms_key_arn != null)
      error_message = "A stack that does not create the session table needs existing_table_name and replica_kms_key_arn (from the primary stack outputs)."
    }
    precondition {
      condition     = var.audit.managed_here || (var.audit.existing_bucket_name != null && var.audit.existing_writer_role_arn != null)
      error_message = "audit.managed_here = false requires existing_bucket_name and existing_writer_role_arn."
    }
    precondition {
      condition     = !local.is_dr || var.aurora.cluster_role == "global_secondary"
      error_message = "The DR stack's ledger must be an Aurora Global Database secondary."
    }
    precondition {
      condition     = var.environment != "production" || var.aurora.deletion_protection
      error_message = "Production databases keep deletion protection."
    }
    precondition {
      condition     = var.environment != "production" || (var.service_sizing["gateway"].min_capacity >= length(var.availability_zones))
      error_message = "Production keeps at least one warm gateway task per AZ."
    }
  }
}

# ------------------------------------------------------------------ keys
module "kms" {
  source = "../kms"

  name_prefix         = var.name_prefix
  account_id          = var.workload_account_id
  region              = var.region
  partition           = var.partition
  key_admin_role_arns = local.key_admins
  tags                = local.base_tags

  keys = {
    logs = {
      description        = "CloudWatch log groups"
      data_class         = "OPERATIONAL_TELEMETRY"
      usage_role_arns    = []
      via_services       = []
      service_principals = ["logs"]
    }
    sessions = {
      description        = "Session table"
      data_class         = "TRANSIENT_CONVERSATION"
      usage_role_arns    = [local.role_arn["gateway-task"]]
      via_services       = ["dynamodb"]
      service_principals = []
    }
    business_records = {
      description        = "Aurora ledger storage, snapshots and Performance Insights"
      data_class         = "BUSINESS_RECORD"
      usage_role_arns    = []
      via_services       = []
      service_principals = []
    }
    messaging = {
      description        = "SQS queues and alarm topic"
      data_class         = "DELIVERY_METADATA"
      usage_role_arns    = [local.role_arn["worker-task"], local.role_arn["workflows"]]
      via_services       = ["sqs", "sns"]
      service_principals = ["cloudwatch_alarms", "budgets"]
    }
    workflows = {
      description        = "Step Functions definitions and execution data"
      data_class         = "DELIVERY_METADATA"
      usage_role_arns    = [local.role_arn["worker-task"], local.role_arn["workflows"]]
      via_services       = ["states"]
      service_principals = []
    }
    secrets = {
      description        = "Secrets Manager secrets"
      data_class         = "CREDENTIALS"
      usage_role_arns    = [local.role_arn["gateway-task"], local.role_arn["worker-task"]]
      via_services       = ["secretsmanager"]
      service_principals = []
    }
    ecr = {
      description        = "Container images"
      data_class         = "BUILD_ARTIFACT"
      usage_role_arns    = [local.role_arn["ecs-execution"]]
      via_services       = ["ecr"]
      service_principals = []
    }
    ephemeral = {
      description        = "Fargate ephemeral storage"
      data_class         = "TRANSIENT_CONVERSATION"
      usage_role_arns    = []
      via_services       = []
      service_principals = ["fargate_ephemeral"]
      ecs_cluster_name   = local.cluster_name
    }
  }
}

# CMK for the DR-region session replica, created by the PRIMARY stack in the DR region
# (provider 6.x per-resource region) so the replica can exist before the DR stack.
resource "aws_kms_key" "session_replica" {
  count = var.sessions.create && var.sessions.replica_region != null ? 1 : 0

  region                  = var.sessions.replica_region
  description             = "${var.name_prefix} sessions replica (${var.sessions.replica_region})"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # kms:CreateAlias, never kms:Create* (it matches kms:CreateGrant): grants come only from
        # AttachKeyToAwsResourcesOnly below (same rule as modules/kms).
        Sid       = "KeyAdministrationWithoutCryptographicUse"
        Effect    = "Allow"
        Principal = { AWS = local.key_admins }
        Action    = ["kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"]
        Resource  = "*"
      },
      {
        Sid       = "AttachKeyToAwsResourcesOnly"
        Effect    = "Allow"
        Principal = { AWS = local.key_admins }
        Action    = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
      {
        Sid       = "DrGatewayUseViaDynamoDB"
        Effect    = "Allow"
        Principal = { AWS = "arn:${var.partition}:iam::${var.workload_account_id}:root" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnEquals    = { "aws:PrincipalArn" = ["arn:${var.partition}:iam::${var.workload_account_id}:role/${coalesce(var.sessions.dr_name_prefix, "unset")}-gateway-task"] }
          StringEquals = { "kms:ViaService" = "dynamodb.${coalesce(var.sessions.replica_region, var.region)}.amazonaws.com" }
        }
      },
    ]
  })

  tags = merge(local.base_tags, { "vsp:data-class" = "TRANSIENT_CONVERSATION" })

  lifecycle {
    precondition {
      condition     = var.sessions.dr_name_prefix != null
      error_message = "sessions.dr_name_prefix is required with replica_region (the DR stack's role names)."
    }
  }
}

# ------------------------------------------------------------------ network and ingress
module "network" {
  source = "../network"

  name_prefix              = var.name_prefix
  account_id               = var.workload_account_id
  trusted_account_ids      = [var.audit_account_id]
  region                   = var.region
  partition                = var.partition
  vpc_cidr                 = var.vpc_cidr
  availability_zones       = var.availability_zones
  nat_gateway_per_az       = var.nat_gateway_per_az
  flow_log_retention_days  = var.retention_days.flow_logs
  logs_kms_key_arn         = module.kms.key_arns["logs"]
  permissions_boundary_arn = var.ci.manage ? module.iam_ci[0].permissions_boundary_arn : null
  tags                     = local.base_tags
}

module "ingress" {
  source = "../ingress"

  name_prefix                  = var.name_prefix
  account_id                   = var.workload_account_id
  region                       = var.region
  partition                    = var.partition
  vpc_id                       = module.network.vpc_id
  public_subnet_ids            = module.network.public_subnet_ids
  certificate_arn              = var.certificate_arn
  idle_timeout_seconds         = var.ingress.idle_timeout_seconds
  http_redirect_enabled        = var.ingress.http_redirect_enabled
  supplemental_allowlist_cidrs = var.ingress.supplemental_allowlist_cidrs
  waf_rate_limit_per_5min      = var.ingress.waf_rate_limit_per_5min
  jwt_validation               = var.ingress.jwt_validation
  elb_log_delivery_account_id  = var.ingress.elb_log_delivery_account_id
  deletion_protection          = var.ingress.deletion_protection
  logs_kms_key_arn             = module.kms.key_arns["logs"]
  waf_log_retention_days       = var.retention_days.waf_logs
  access_log_expiration_days   = var.retention_days.alb_access_logs
  tags                         = local.base_tags
}

# ------------------------------------------------------------------ state
module "dynamodb_sessions" {
  source = "../dynamodb_sessions"
  count  = var.sessions.create ? 1 : 0

  name_prefix  = var.name_prefix
  kms_key_arn  = module.kms.key_arns["sessions"]
  billing_mode = var.sessions.billing_mode
  replicas     = var.sessions.replica_region == null ? [] : [{ region_name = var.sessions.replica_region, kms_key_arn = aws_kms_key.session_replica[0].arn }]
  tags         = local.base_tags
}

module "sqs" {
  source = "../sqs"

  name_prefix     = var.name_prefix
  account_id      = var.workload_account_id
  kms_key_arn     = module.kms.key_arns["messaging"]
  queues          = local.queue_defs
  alarm_topic_arn = module.observability.alarm_topic_arn
  tags            = local.base_tags
}

module "secrets" {
  source = "../secrets"

  name_prefix     = var.name_prefix
  kms_key_arn     = module.kms.key_arns["secrets"]
  admin_role_arns = local.key_admins
  tags            = local.base_tags

  secrets = {
    for k, s in local.secret_defs : k => {
      description         = "${s.description}. Value loaded by the owner; never by Terraform."
      owner               = s.owner
      reader_role_arns    = [for svc in s.readers : local.role_arn["${svc}-task"]]
      rotation_lambda_arn = try(var.secret_rotation_hooks[k].lambda_arn, null)
      rotation_days       = try(var.secret_rotation_hooks[k].days, null)
    }
  }
}

module "aurora" {
  source = "../aurora"

  name_prefix                    = var.name_prefix
  vpc_id                         = module.network.vpc_id
  data_subnet_ids                = module.network.data_subnet_ids
  availability_zones             = var.availability_zones
  client_security_group_ids      = module.ecs.security_group_ids
  cluster_role                   = var.aurora.cluster_role
  global_cluster_identifier      = var.aurora.global_cluster_identifier
  engine_version                 = var.aurora.engine_version
  instance_class                 = var.aurora.instance_class
  instance_count                 = var.aurora.instance_count
  storage_kms_key_arn            = module.kms.key_arns["business_records"]
  master_user_secret_kms_key_arn = module.kms.key_arns["secrets"]
  backup_retention_days          = var.aurora.backup_retention_days
  deletion_protection            = var.aurora.deletion_protection
  log_retention_days             = var.retention_days.database_logs
  logs_kms_key_arn               = module.kms.key_arns["logs"]
  tags                           = local.base_tags
}

module "step_functions" {
  source = "../step_functions"

  name_prefix              = var.name_prefix
  account_id               = var.workload_account_id
  region                   = var.region
  partition                = var.partition
  definitions_dir          = var.asl_dir
  log_level                = var.workflow_log_level
  kms_key_arn              = module.kms.key_arns["workflows"]
  logs_kms_key_arn         = module.kms.key_arns["logs"]
  log_retention_days       = var.retention_days.workflow_logs
  send_queue_arns          = [for p, q in local.workflow_queue_placeholders : module.sqs.queue_arns[q]]
  queue_kms_key_arn        = module.kms.key_arns["messaging"]
  definition_substitutions = { for p, q in local.workflow_queue_placeholders : p => module.sqs.queue_urls[q] }
  permissions_boundary_arn = var.ci.manage ? module.iam_ci[0].permissions_boundary_arn : null
  tags                     = local.base_tags
}

# ------------------------------------------------------------------ compute
module "ecs" {
  source = "../ecs_service"

  name_prefix                   = var.name_prefix
  environment                   = var.environment
  account_id                    = var.workload_account_id
  region                        = var.region
  partition                     = var.partition
  vpc_id                        = module.network.vpc_id
  app_subnet_ids                = module.network.app_subnet_ids
  endpoint_security_group_id    = module.network.endpoint_security_group_id
  s3_prefix_list_id             = module.network.s3_prefix_list_id
  dynamodb_prefix_list_id       = module.network.dynamodb_prefix_list_id
  create_ecr_repository         = var.image.create_ecr_repository
  image_repository_url          = var.image.repository_url
  image_repository_arn          = var.image.repository_arn
  image_digest                  = var.image.digest
  cpu_architecture              = var.image.cpu_architecture
  target_group_arn              = module.ingress.target_group_arn
  target_group_arn_suffix       = module.ingress.target_group_arn_suffix
  alb_arn_suffix                = module.ingress.alb_arn_suffix
  alb_security_group_id         = module.ingress.alb_security_group_id
  log_retention_days            = var.retention_days.application_logs
  logs_kms_key_arn              = module.kms.key_arns["logs"]
  ecr_kms_key_arn               = module.kms.key_arns["ecr"]
  secrets_kms_key_arn           = module.kms.key_arns["secrets"]
  ephemeral_storage_kms_key_arn = module.kms.key_arns["ephemeral"]
  permissions_boundary_arn      = var.ci.manage ? module.iam_ci[0].permissions_boundary_arn : null
  tags                          = local.base_tags

  write_fence = {
    mutations_enabled            = var.mutations_enabled
    protected_table_arns         = [local.sessions_table_arn]
    protected_queue_arns         = values(module.sqs.queue_arns)
    protected_state_machine_arns = ["${module.step_functions.state_machine_arn_prefix}*"]
  }

  services = {
    gateway = {
      command                     = var.service_commands["gateway"]
      cpu                         = var.service_sizing["gateway"].cpu
      memory                      = var.service_sizing["gateway"].memory
      min_capacity                = var.service_sizing["gateway"].min_capacity
      max_capacity                = var.service_sizing["gateway"].max_capacity
      requests_per_target         = var.service_sizing["gateway"].requests_per_target
      container_port              = 8080
      attach_to_load_balancer     = true
      environment                 = merge(local.common_env, { VSP_SECRET_REFS = jsonencode(local.secret_refs["gateway"]) })
      secret_arns                 = {}
      task_role_policy_json       = local.gateway_policy
      allow_internet_egress_https = true
      health_check_command        = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
    }
    worker = {
      command                 = var.service_commands["worker"]
      cpu                     = var.service_sizing["worker"].cpu
      memory                  = var.service_sizing["worker"].memory
      min_capacity            = var.service_sizing["worker"].min_capacity
      max_capacity            = var.service_sizing["worker"].max_capacity
      attach_to_load_balancer = false
      environment = merge(local.common_env, {
        PORT                      = "8081"
        VSP_SECRET_REFS           = jsonencode(local.secret_refs["worker"])
        VSP_QUEUE_URLS            = jsonencode({ for t, q in module.sqs.topic_routes : t => module.sqs.queue_urls[q] })
        VSP_STATE_MACHINE_ARNS    = jsonencode(module.step_functions.state_machine_alias_arns)
        VSP_AUDIT_BUCKET          = local.audit_bucket_name
        VSP_AUDIT_PREFIX          = "audit/"
        VSP_AUDIT_REGION          = var.audit_region
        VSP_AUDIT_WRITER_ROLE_ARN = local.audit_writer_role_arn
      })
      secret_arns                 = {}
      task_role_policy_json       = local.worker_policy
      allow_internet_egress_https = true
      health_check_command        = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8081/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
    }
  }
}

# ------------------------------------------------------------------ evidence, telemetry, cost, CI
module "audit" {
  source = "../audit"
  count  = var.audit.managed_here ? 1 : 0

  providers = {
    aws.audit = aws.audit
  }

  name_prefix                = var.name_prefix
  audit_account_id           = var.audit_account_id
  workload_account_id        = var.workload_account_id
  region                     = var.audit_region
  partition                  = var.partition
  object_lock_mode           = var.audit.object_lock_mode
  object_lock_retention_days = var.audit.object_lock_retention_days
  writer_principal_arns      = distinct(concat([local.role_arn["worker-task"]], var.audit.additional_writer_role_arns))
  auditor_principal_arns     = var.audit.auditor_principal_arns
  key_admin_role_arns        = var.audit.key_admin_role_arns
  legal_hold_role_arns       = var.audit.legal_hold_role_arns
  tags                       = local.base_tags
}

module "observability" {
  source = "../observability"

  name_prefix               = var.name_prefix
  account_id                = var.workload_account_id
  region                    = var.region
  messaging_kms_key_arn     = module.kms.key_arns["messaging"]
  logs_kms_key_arn          = module.kms.key_arns["logs"]
  log_retention_days        = var.retention_days.metrics_logs
  alb_arn_suffix            = module.ingress.alb_arn_suffix
  target_group_arn_suffix   = module.ingress.target_group_arn_suffix
  ecs_cluster_name          = local.cluster_name
  ecs_service_names         = { gateway = "gateway", worker = "worker" }
  aurora_cluster_identifier = "${var.name_prefix}-ledger"
  sessions_table_name       = coalesce(var.sessions.existing_table_name, "${var.name_prefix}-sessions")
  queue_names               = { for k, q in local.queue_defs : k => "${var.name_prefix}-${k}${q.fifo ? ".fifo" : ""}" }
  tags                      = local.base_tags
}

module "budgets" {
  source = "../budgets"
  count  = var.budget.create ? 1 : 0

  name_prefix       = var.name_prefix
  monthly_limit_usd = var.budget.monthly_limit_usd
  alarm_topic_arn   = module.observability.alarm_topic_arn
}

module "iam_ci" {
  source = "../iam_ci"
  count  = var.ci.manage ? 1 : 0

  name_prefix              = var.name_prefix
  account_id               = var.workload_account_id
  partition                = var.partition
  allowed_regions          = var.ci.allowed_regions
  github_repository        = var.github_repository
  github_environment       = var.ci.github_environment
  create_oidc_provider     = var.ci.create_oidc_provider
  oidc_provider_arn        = var.ci.oidc_provider_arn
  state_bucket_arn         = var.ci.state_bucket_arn
  state_key_prefix         = var.ci.state_key_prefix
  state_kms_key_arn        = var.ci.state_kms_key_arn
  deny_destructive_actions = var.environment != "sandbox"
  tags                     = local.base_tags
}
