# [SPEC-3.ecs] [SPEC-14.workload] Fargate gateway + worker: digest-pinned image,
# non-root, read-only root FS, no public IP, no ECS Exec, least-privilege task
# roles, warm minimum capacity, circuit-breaker rollback, regional write fence.
# Offline: mock provider, plan only.

mock_provider "aws" {}

variables {
  name_prefix                = "vsp-test"
  environment                = "sandbox"
  account_id                 = "111111111111"
  region                     = "us-east-1"
  vpc_id                     = "vpc-0123456789abcdef0"
  app_subnet_ids             = ["subnet-0000000000000000a", "subnet-0000000000000000b", "subnet-0000000000000000c"]
  endpoint_security_group_id = "sg-00000000000000001"
  s3_prefix_list_id          = "pl-00000001"
  dynamodb_prefix_list_id    = "pl-00000002"
  create_ecr_repository      = false
  image_repository_url       = "111111111111.dkr.ecr.us-east-1.amazonaws.com/vsp-test/platform"
  image_repository_arn       = "arn:aws:ecr:us-east-1:111111111111:repository/vsp-test/platform"
  image_digest               = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  target_group_arn           = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/vsp-test-gateway/0123456789abcdef"
  target_group_arn_suffix    = "targetgroup/vsp-test-gateway/0123456789abcdef"
  alb_arn_suffix             = "app/vsp-test-ingress/0123456789abcdef"
  alb_security_group_id      = "sg-00000000000000002"
  log_retention_days         = 30
  logs_kms_key_arn           = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
  secrets_kms_key_arn        = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000002"
  write_fence = {
    mutations_enabled            = true
    protected_table_arns         = ["arn:aws:dynamodb:us-east-1:111111111111:table/vsp-test-sessions"]
    protected_queue_arns         = ["arn:aws:sqs:us-east-1:111111111111:vsp-test-crm-sync.fifo"]
    protected_state_machine_arns = []
  }
  services = {
    gateway = {
      command                     = ["node", "dist/main/server.js"]
      cpu                         = 1024
      memory                      = 2048
      min_capacity                = 3
      max_capacity                = 12
      container_port              = 8080
      attach_to_load_balancer     = true
      requests_per_target         = 1000
      environment                 = { VSP_SESSION_TABLE = "vsp-test-sessions" }
      secret_arns                 = { VSP_SALESFORCE_OAUTH = "arn:aws:secretsmanager:us-east-1:111111111111:secret:vsp/test/salesforce-AbCdEf" }
      task_role_policy_json       = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\"],\"Resource\":[\"arn:aws:dynamodb:us-east-1:111111111111:table/vsp-test-sessions\"]}]}"
      allow_internet_egress_https = true
      health_check_command        = ["CMD", "node", "/app/healthcheck.mjs"]
    }
    worker = {
      command                     = ["node", "dist/worker/main.js"]
      cpu                         = 512
      memory                      = 1024
      min_capacity                = 2
      max_capacity                = 6
      attach_to_load_balancer     = false
      environment                 = {}
      secret_arns                 = {}
      task_role_policy_json       = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"sqs:ReceiveMessage\"],\"Resource\":[\"arn:aws:sqs:us-east-1:111111111111:vsp-test-crm-sync.fifo\"]}]}"
      allow_internet_egress_https = true
      health_check_command        = ["CMD", "node", "/app/healthcheck.mjs"]
    }
  }
}

run "hardened_tasks" {
  command = plan

  assert {
    condition     = alltrue([for k, d in local.container_definitions : d[0].readonlyRootFilesystem == true && d[0].privileged == false])
    error_message = "[SPEC-14.workload] read-only root filesystem, never privileged"
  }

  assert {
    condition     = alltrue([for k, d in local.container_definitions : d[0].user == "10001:10001"])
    error_message = "[SPEC-14.workload] containers run as a non-root numeric user"
  }

  assert {
    condition     = alltrue([for k, d in local.container_definitions : d[0].linuxParameters.capabilities.drop == ["ALL"]])
    error_message = "all Linux capabilities dropped"
  }

  assert {
    condition     = alltrue([for k, d in local.container_definitions : endswith(d[0].image, "@sha256:0000000000000000000000000000000000000000000000000000000000000000")])
    error_message = "[OPS-06] images are referenced by digest, never by tag"
  }

  assert {
    condition     = alltrue([for s in aws_ecs_service.service : s.network_configuration[0].assign_public_ip == false && s.enable_execute_command == false])
    error_message = "[SPEC-3.ecs] no public IPs and no ECS Exec shell"
  }

  assert {
    condition     = alltrue([for s in aws_ecs_service.service : s.deployment_circuit_breaker[0].enable && s.deployment_circuit_breaker[0].rollback])
    error_message = "[SPEC-15.release] deployment circuit breaker rolls back automatically"
  }

  assert {
    condition     = aws_appautoscaling_target.service["gateway"].min_capacity == 3 && aws_appautoscaling_target.service["worker"].min_capacity == 2
    error_message = "[SPEC-12.capacity] minimum warm capacity is enforced by autoscaling"
  }

  assert {
    condition     = length(aws_appautoscaling_policy.requests) == 1
    error_message = "gateway scales on ALB request count as well as CPU"
  }

  assert {
    condition     = aws_iam_role.task["gateway"].name != aws_iam_role.task["worker"].name
    error_message = "[SPEC-14.iam] each service has its own task role"
  }

  assert {
    condition = alltrue([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement :
    st.Resource == "*" ? st.Action == ["ecr:GetAuthorizationToken"] : true])
    error_message = "[SPEC-14.iam] the only wildcard resource in the execution role is ecr:GetAuthorizationToken"
  }

  assert {
    condition = one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadInjectedSecretsOnly"]) == [
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:vsp/test/salesforce-AbCdEf"]
    error_message = "execution role reads only the injected secrets"
  }

  assert {
    condition     = length(aws_iam_role_policy.fence) == 0 && contains([for e in local.container_definitions["gateway"][0].environment : "${e.name}=${e.value}"], "VSP_MUTATIONS_ENABLED=true")
    error_message = "no fence when mutations are enabled"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.from_alb) == 1 && aws_vpc_security_group_ingress_rule.from_alb["gateway"].referenced_security_group_id == "sg-00000000000000002"
    error_message = "only the gateway accepts traffic, and only from the ALB security group"
  }

  assert {
    condition     = alltrue([for g in aws_cloudwatch_log_group.service : g.kms_key_id == var.logs_kms_key_arn])
    error_message = "[SPEC-6.logs] application log groups are KMS encrypted"
  }

  assert {
    condition     = length(local.container_definitions["gateway"][0].secrets) == 1 && local.container_definitions["gateway"][0].secrets[0].valueFrom == "arn:aws:secretsmanager:us-east-1:111111111111:secret:vsp/test/salesforce-AbCdEf"
    error_message = "[AUTH-06] secrets are injected by reference, never as values"
  }
}

run "dr_write_fence" {
  command = plan

  variables {
    write_fence = {
      mutations_enabled            = false
      protected_table_arns         = ["arn:aws:dynamodb:us-east-2:111111111111:table/vsp-test-sessions"]
      protected_queue_arns         = ["arn:aws:sqs:us-east-2:111111111111:vsp-test-crm-sync.fifo"]
      protected_state_machine_arns = ["arn:aws:states:us-east-2:111111111111:stateMachine:vsp-test-billing-dispute-review"]
    }
  }

  assert {
    condition     = length(aws_iam_role_policy.fence) == 2
    error_message = "[SPEC-12.fence] every task role gets the explicit write fence"
  }

  assert {
    condition     = alltrue([for st in jsondecode(aws_iam_role_policy.fence["gateway"].policy).Statement : st.Effect == "Deny"])
    error_message = "the fence is an explicit Deny"
  }

  assert {
    condition     = contains([for e in local.container_definitions["worker"][0].environment : "${e.name}=${e.value}"], "VSP_MUTATIONS_ENABLED=false")
    error_message = "containers are told mutations are disabled"
  }
}

run "rejects_tag_reference" {
  command = plan

  variables {
    image_digest = "latest"
  }

  expect_failures = [var.image_digest]
}

run "rejects_zero_warm_capacity" {
  command = plan

  variables {
    services = {
      worker = {
        command                     = ["node", "dist/worker/main.js"]
        cpu                         = 512
        memory                      = 1024
        min_capacity                = 0
        max_capacity                = 2
        attach_to_load_balancer     = false
        environment                 = {}
        secret_arns                 = {}
        task_role_policy_json       = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
        allow_internet_egress_https = false
        health_check_command        = ["CMD", "true"]
      }
    }
  }

  expect_failures = [var.services]
}

run "rejects_overriding_managed_environment" {
  command = plan

  variables {
    services = {
      worker = {
        command                     = ["node", "dist/worker/main.js"]
        cpu                         = 512
        memory                      = 1024
        min_capacity                = 1
        max_capacity                = 2
        attach_to_load_balancer     = false
        environment                 = { VSP_MUTATIONS_ENABLED = "true" }
        secret_arns                 = {}
        task_role_policy_json       = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
        allow_internet_egress_https = false
        health_check_command        = ["CMD", "true"]
      }
    }
  }

  expect_failures = [var.services]
}
