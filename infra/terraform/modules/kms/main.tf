# Customer-managed KMS keys, one per data class / purpose (spec sections 6 and 14).
# Key policies never grant kms:* and never use Principal "*". Administration and
# cryptographic use are separate statements; workload use is restricted to exact
# role ARNs (aws:PrincipalArn) and, where configured, to calls made through a
# specific AWS service (kms:ViaService).

locals {
  root_arn = "arn:${var.partition}:iam::${var.account_id}:root"

  # No "kms:Create*": it also matches kms:CreateGrant, which would let any key administrator
  # grant the key to any grantee (including another account) and make the conditioned
  # AttachKeyToAwsResourcesOnly statement meaningless. CreateAlias is the only other create
  # action a key policy authorizes (CreateKey is authorized by IAM alone); aws_kms_alias needs it.
  admin_actions = [
    "kms:CreateAlias",
    "kms:Describe*",
    "kms:Enable*",
    "kms:List*",
    "kms:Put*",
    "kms:Update*",
    "kms:Revoke*",
    "kms:Disable*",
    "kms:Get*",
    "kms:Delete*",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:ScheduleKeyDeletion",
    "kms:CancelKeyDeletion",
    "kms:RotateKeyOnDemand",
  ]

  usage_actions = [
    "kms:Encrypt",
    "kms:Decrypt",
    "kms:ReEncrypt*",
    "kms:GenerateDataKey*",
    "kms:DescribeKey",
  ]

  service_statements = {
    logs = {
      Sid       = "AllowCloudWatchLogsInThisAccount"
      Effect    = "Allow"
      Principal = { Service = "logs.${var.region}.amazonaws.com" }
      Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
      Resource  = "*"
      Condition = {
        ArnLike = {
          "kms:EncryptionContext:aws:logs:arn" = "arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group:*"
        }
      }
    }
    cloudwatch_alarms = {
      Sid       = "AllowCloudWatchAlarmsToPublishToEncryptedTopics"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
      Resource  = "*"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }
    budgets = {
      Sid       = "AllowBudgetsToPublishToEncryptedTopics"
      Effect    = "Allow"
      Principal = { Service = "budgets.amazonaws.com" }
      Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
      Resource  = "*"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }
  }

  key_policies = {
    for name, k in var.keys : name => jsonencode({
      Version = "2012-10-17"
      Statement = concat(
        [
          {
            Sid       = "KeyAdministrationWithoutCryptographicUse"
            Effect    = "Allow"
            Principal = { AWS = var.key_admin_role_arns }
            Action    = local.admin_actions
            Resource  = "*"
          },
          {
            Sid       = "AttachKeyToAwsResourcesOnly"
            Effect    = "Allow"
            Principal = { AWS = var.key_admin_role_arns }
            Action    = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]
            Resource  = "*"
            Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
          },
        ],
        length(k.usage_role_arns) == 0 ? [] : [
          {
            Sid       = "WorkloadUseByNamedRolesOnly"
            Effect    = "Allow"
            Principal = { AWS = local.root_arn }
            Action    = local.usage_actions
            Resource  = "*"
            Condition = merge(
              { ArnEquals = { "aws:PrincipalArn" = k.usage_role_arns } },
              length(k.via_services) == 0 ? {} : {
                StringEquals = {
                  "kms:ViaService"    = [for s in k.via_services : "${s}.${var.region}.amazonaws.com"]
                  "kms:CallerAccount" = var.account_id
                }
              },
            )
          },
        ],
        [for s in k.service_principals : local.service_statements[s] if s != "fargate_ephemeral"],
        contains(k.service_principals, "fargate_ephemeral") ? [
          {
            # Fargate ephemeral storage encryption (verify statement against current ECS documentation before apply).
            Sid       = "AllowFargateEphemeralStorageDataKeys"
            Effect    = "Allow"
            Principal = { Service = "fargate.amazonaws.com" }
            Action    = ["kms:GenerateDataKeyWithoutPlaintext"]
            Resource  = "*"
            Condition = {
              StringEquals = {
                "kms:EncryptionContext:aws:ecs:clusterAccount" = [var.account_id]
                "kms:EncryptionContext:aws:ecs:clusterName"    = [k.ecs_cluster_name]
              }
            }
          },
          {
            Sid       = "AllowFargateEphemeralStorageGrants"
            Effect    = "Allow"
            Principal = { Service = "fargate.amazonaws.com" }
            Action    = ["kms:CreateGrant"]
            Resource  = "*"
            Condition = {
              StringEquals = {
                "kms:EncryptionContext:aws:ecs:clusterAccount" = [var.account_id]
                "kms:EncryptionContext:aws:ecs:clusterName"    = [k.ecs_cluster_name]
              }
              "ForAllValues:StringEquals" = { "kms:GrantOperations" = ["Decrypt"] }
            }
          },
        ] : [],
      )
    })
  }
}

resource "aws_kms_key" "this" {
  for_each = var.keys

  description              = "${var.name_prefix} ${each.key}: ${each.value.description}"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  rotation_period_in_days  = var.rotation_period_in_days
  deletion_window_in_days  = var.deletion_window_in_days
  multi_region             = false
  policy                   = local.key_policies[each.key]

  bypass_policy_lockout_safety_check = false

  tags = merge(var.tags, {
    "vsp:data-class" = each.value.data_class
    "vsp:purpose"    = each.key
  })
}

resource "aws_kms_alias" "this" {
  for_each = var.keys

  name          = "alias/${var.name_prefix}-${replace(each.key, "_", "-")}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
