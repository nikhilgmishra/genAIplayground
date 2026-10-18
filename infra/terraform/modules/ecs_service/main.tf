# ECS Fargate services for the gateway and the worker (spec sections 3, 12, 14).
# Tasks run by image digest, as a non-root numeric user, with a read-only root
# filesystem, all Linux capabilities dropped, no public IP, no ECS Exec shell,
# per-service least-privilege task roles, minimum warm capacity and a deployment
# circuit breaker that rolls back automatically.

locals {
  cluster_name = "${var.name_prefix}-cluster"
  repo_url     = var.create_ecr_repository ? aws_ecr_repository.this[0].repository_url : var.image_repository_url
  repo_arn     = var.create_ecr_repository ? aws_ecr_repository.this[0].arn : var.image_repository_arn
  image        = "${local.repo_url}@${var.image_digest}"

  lb_services = { for k, s in var.services : k => s if s.attach_to_load_balancer }

  managed_env = {
    VSP_ENVIRONMENT       = var.environment
    VSP_MUTATIONS_ENABLED = tostring(var.write_fence.mutations_enabled)
    NODE_ENV              = "production"
    AWS_REGION            = var.region
  }

  container_definitions = {
    for name, s in var.services : name => [{
      name                   = name
      image                  = local.image
      essential              = true
      command                = s.command
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      privileged             = false
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { add = [], drop = ["ALL"] }
      }
      portMappings = s.container_port == null ? [] : [{ containerPort = s.container_port, protocol = "tcp", name = "http" }]
      environment  = [for k in sort(keys(merge(s.environment, local.managed_env))) : { name = k, value = merge(s.environment, local.managed_env)[k] }]
      secrets      = [for k in sort(keys(s.secret_arns)) : { name = k, valueFrom = s.secret_arns[k] }]
      mountPoints  = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/vsp/${var.name_prefix}/ecs/${name}"
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = name
          "mode"                  = "non-blocking"
          "max-buffer-size"       = "25m"
        }
      }
      healthCheck = {
        command     = s.health_check_command
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      stopTimeout = 30
    }]
  }

  all_secret_arns = distinct(flatten([for s in values(var.services) : values(s.secret_arns)]))

  ecs_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${var.partition}:ecs:${var.region}:${var.account_id}:*" }
      }
    }]
  })

  fence_statements = concat(
    length(var.write_fence.protected_table_arns) == 0 ? [] : [{
      Sid    = "RegionalWriteFenceDynamoDB"
      Effect = "Deny"
      Action = [
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:PartiQLInsert",
        "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete",
      ]
      Resource = flatten([for a in var.write_fence.protected_table_arns : [a, "${a}/*"]])
    }],
    length(var.write_fence.protected_queue_arns) == 0 ? [] : [{
      Sid      = "RegionalWriteFenceSQS"
      Effect   = "Deny"
      Action   = ["sqs:SendMessage"]
      Resource = var.write_fence.protected_queue_arns
    }],
    length(var.write_fence.protected_state_machine_arns) == 0 ? [] : [{
      Sid      = "RegionalWriteFenceStepFunctions"
      Effect   = "Deny"
      Action   = ["states:StartExecution", "states:SendTaskSuccess", "states:SendTaskFailure"]
      Resource = var.write_fence.protected_state_machine_arns
    }],
  )

  fence_policy = jsonencode({ Version = "2012-10-17", Statement = local.fence_statements })
  fenced       = !var.write_fence.mutations_enabled && length(local.fence_statements) > 0
}

resource "terraform_data" "fence_guard" {
  input = var.write_fence.mutations_enabled

  lifecycle {
    precondition {
      condition     = var.write_fence.mutations_enabled || length(local.fence_statements) > 0
      error_message = "mutations_enabled = false requires at least one protected resource ARN so the IAM fence is real."
    }
  }
}

# ---------------------------------------------------------------- registry
resource "aws_ecr_repository" "this" {
  count = var.create_ecr_repository ? 1 : 0

  name                 = "${var.name_prefix}/platform"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.ecr_kms_key_arn
  }

  tags = merge(var.tags, { "vsp:data-class" = "BUILD_ARTIFACT" })

  lifecycle {
    precondition {
      condition     = var.ecr_kms_key_arn != null
      error_message = "ecr_kms_key_arn is required when the repository is created here."
    }
  }
}

resource "terraform_data" "repository_guard" {
  input = var.create_ecr_repository

  lifecycle {
    precondition {
      condition     = var.create_ecr_repository || (var.image_repository_url != null && var.image_repository_arn != null)
      error_message = "image_repository_url and image_repository_arn are required when create_ecr_repository = false."
    }
  }
}

# ---------------------------------------------------------------- cluster
resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }

  dynamic "configuration" {
    for_each = var.ephemeral_storage_kms_key_arn == null ? [] : [1]
    content {
      managed_storage_configuration {
        fargate_ephemeral_storage_kms_key_id = var.ephemeral_storage_kms_key_arn
      }
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = var.services

  name                        = "/vsp/${var.name_prefix}/ecs/${each.key}"
  retention_in_days           = var.log_retention_days
  kms_key_id                  = var.logs_kms_key_arn
  deletion_protection_enabled = true

  tags = merge(var.tags, { "vsp:data-class" = "OPERATIONAL_TELEMETRY", "vsp:service" = each.key })
}

# ---------------------------------------------------------------- IAM
resource "aws_iam_role" "execution" {
  name                 = "${var.name_prefix}-ecs-execution"
  assume_role_policy   = local.ecs_trust
  permissions_boundary = var.permissions_boundary_arn

  tags = var.tags
}

resource "aws_iam_role_policy" "execution" {
  name = "pull-image-write-logs-read-own-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "EcrAuthToken"
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = "*"
        },
        {
          Sid      = "PullPlatformImageOnly"
          Effect   = "Allow"
          Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
          Resource = [local.repo_arn]
        },
        {
          Sid      = "WriteOwnLogGroups"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = [for name in keys(var.services) : "arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group:/vsp/${var.name_prefix}/ecs/${name}:*"]
        },
      ],
      [for st in [
        {
          Sid      = "ReadInjectedSecretsOnly"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = local.all_secret_arns
        },
        {
          Sid       = "DecryptSecretsViaSecretsManager"
          Effect    = "Allow"
          Action    = ["kms:Decrypt"]
          Resource  = [var.secrets_kms_key_arn]
          Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
        },
      ] : st if length(local.all_secret_arns) > 0],
      var.create_ecr_repository ? [{
        Sid       = "DecryptImageLayersViaEcr"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [var.ecr_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "ecr.${var.region}.amazonaws.com" } }
      }] : [],
    )
  })
}

resource "aws_iam_role" "task" {
  for_each = var.services

  name                 = "${var.name_prefix}-${each.key}-task"
  assume_role_policy   = local.ecs_trust
  permissions_boundary = var.permissions_boundary_arn

  tags = merge(var.tags, { "vsp:service" = each.key })
}

resource "aws_iam_role_policy" "task" {
  for_each = var.services

  name   = "${each.key}-least-privilege"
  role   = aws_iam_role.task[each.key].id
  policy = each.value.task_role_policy_json
}

resource "aws_iam_role_policy" "fence" {
  for_each = local.fenced ? var.services : {}

  name   = "regional-write-fence"
  role   = aws_iam_role.task[each.key].id
  policy = local.fence_policy
}

# ---------------------------------------------------------------- networking
resource "aws_security_group" "service" {
  for_each = var.services

  name        = "${var.name_prefix}-${each.key}"
  description = "${each.key} tasks: no inbound except from the ALB (gateway only)"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.key}", "vsp:service" = each.key })
}

resource "aws_vpc_security_group_egress_rule" "to_endpoints" {
  for_each = var.services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "AWS APIs via interface endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = var.endpoint_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "to_s3" {
  for_each = var.services

  security_group_id = aws_security_group.service[each.key].id
  description       = "S3 via gateway endpoint (image layers, audit evidence)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = var.s3_prefix_list_id
}

resource "aws_vpc_security_group_egress_rule" "to_dynamodb" {
  for_each = var.services

  security_group_id = aws_security_group.service[each.key].id
  description       = "DynamoDB via gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = var.dynamodb_prefix_list_id
}

# Vendor SaaS APIs (Salesforce, Talkdesk, IdPs) over TLS through NAT. Security groups
# cannot filter by hostname; an egress FQDN allowlist (e.g. AWS Network Firewall) is a
# recorded prerequisite for DATA-01 defence in depth.
resource "aws_vpc_security_group_egress_rule" "vendor_https" {
  for_each = { for k, s in var.services : k => s if s.allow_internet_egress_https }

  security_group_id = aws_security_group.service[each.key].id
  description       = "Vendor SaaS APIs over HTTPS via NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"

  tags = merge(var.tags, { "vsp:egress" = "vendor-saas-https" })
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  for_each = local.lb_services

  security_group_id            = aws_security_group.service[each.key].id
  description                  = "Gateway port from the ALB only"
  ip_protocol                  = "tcp"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  referenced_security_group_id = var.alb_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  for_each = local.lb_services

  security_group_id            = var.alb_security_group_id
  description                  = "ALB to gateway tasks only"
  ip_protocol                  = "tcp"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  referenced_security_group_id = aws_security_group.service[each.key].id
}

# ---------------------------------------------------------------- tasks and services
resource "aws_ecs_task_definition" "service" {
  for_each = var.services

  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  container_definitions    = jsonencode(local.container_definitions[each.key])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  tags = merge(var.tags, { "vsp:service" = each.key })
}

resource "aws_ecs_service" "service" {
  for_each = var.services

  name             = each.key
  cluster          = aws_ecs_cluster.this.arn
  task_definition  = aws_ecs_task_definition.service[each.key].arn
  desired_count    = each.value.min_capacity
  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  availability_zone_rebalancing      = "ENABLED"
  health_check_grace_period_seconds  = each.value.attach_to_load_balancer ? 60 : null
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.service[each.key].id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.attach_to_load_balancer ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  lifecycle {
    ignore_changes = [desired_count]

    precondition {
      condition     = !each.value.attach_to_load_balancer || (var.target_group_arn != null && var.alb_security_group_id != null)
      error_message = "A load-balanced service needs target_group_arn and alb_security_group_id."
    }
  }

  tags = merge(var.tags, { "vsp:service" = each.key })
}

resource "aws_appautoscaling_target" "service" {
  for_each = var.services

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.service[each.key].name}"
  min_capacity       = each.value.min_capacity
  max_capacity       = each.value.max_capacity
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = var.services

  name               = "${each.key}-cpu-target"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "requests" {
  for_each = { for k, s in local.lb_services : k => s if s.requests_per_target != null }

  name               = "${each.key}-request-count-target"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.requests_per_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${var.alb_arn_suffix}/${var.target_group_arn_suffix}"
    }
  }
}
