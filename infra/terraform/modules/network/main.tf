# VPC across >= 3 AZs (spec section 3). Public subnets host only the ALB and NAT
# gateways; application tasks run in private app subnets; Aurora and other
# stateful services live in private data subnets with no internet route. AWS APIs
# are reached through VPC endpoints. Flow logs go to a KMS-encrypted log group.

locals {
  az_count = length(var.availability_zones)
  azs      = { for i, az in var.availability_zones : az => i }

  # /16 -> /20 blocks: app = 0..3, data = 4..7, public = 8..11 (max 4 AZs).
  app_cidrs    = { for az, i in local.azs : az => cidrsubnet(var.vpc_cidr, 4, i) }
  data_cidrs   = { for az, i in local.azs : az => cidrsubnet(var.vpc_cidr, 4, 4 + i) }
  public_cidrs = { for az, i in local.azs : az => cidrsubnet(var.vpc_cidr, 4, 8 + i) }

  nat_azs = var.nat_gateway_per_az ? var.availability_zones : [var.availability_zones[0]]

  principal_accounts = distinct(concat([var.account_id], var.trusted_account_ids))

  endpoint_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyPrincipalsFromTrustedAccounts"
      Effect    = "Allow"
      Principal = "*"
      Action    = "*"
      Resource  = "*"
      Condition = { StringEquals = { "aws:PrincipalAccount" = local.principal_accounts } }
    }]
  })

  flow_log_group_name = "/vsp/${var.name_prefix}/network/vpc-flow-logs"
}

resource "terraform_data" "az_limit" {
  input = local.az_count

  lifecycle {
    precondition {
      condition     = local.az_count <= 4
      error_message = "The subnet layout supports at most four availability zones."
    }
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpc" })
}

# Lock down the default security group: no rules at all.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-default-deny" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  for_each = local.public_cidrs

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "${var.name_prefix}-public-${each.key}", "vsp:tier" = "public-alb-nat-only" })
}

resource "aws_subnet" "app" {
  for_each = local.app_cidrs

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "${var.name_prefix}-app-${each.key}", "vsp:tier" = "private-app" })
}

resource "aws_subnet" "data" {
  for_each = local.data_cidrs

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "${var.name_prefix}-data-${each.key}", "vsp:tier" = "private-data" })
}

resource "aws_eip" "nat" {
  for_each = toset(local.nat_azs)

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-nat-${each.key}" })
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_azs)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags       = merge(var.tags, { Name = "${var.name_prefix}-nat-${each.key}" })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "app" {
  for_each = local.azs

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-app-${each.key}" })
}

# Application egress (vendor SaaS APIs over TLS) leaves through the AZ's NAT gateway.
resource "aws_route" "app_nat" {
  for_each = local.azs

  route_table_id         = aws_route_table.app[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.nat_gateway_per_az ? aws_nat_gateway.this[each.key].id : aws_nat_gateway.this[local.nat_azs[0]].id
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app[each.key].id
}

# Data subnets have no default route: no internet path in either direction.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-data-isolated" })
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

resource "aws_vpc_endpoint" "gateway" {
  for_each = toset(["s3", "dynamodb"])

  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat([for rt in aws_route_table.app : rt.id], [aws_route_table.data.id])
  policy            = local.endpoint_policy

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.key}-gateway-endpoint" })
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-vpc-endpoints"
  description = "Interface VPC endpoints: HTTPS from inside the VPC only"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpc-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS from VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr

  tags = merge(var.tags, { "vsp:exposure" = "vpc-internal" })
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for s in aws_subnet.app : s.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  policy              = local.endpoint_policy

  tags = merge(var.tags, { Name = "${var.name_prefix}-${replace(each.key, ".", "-")}-endpoint" })
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name                        = local.flow_log_group_name
  retention_in_days           = var.flow_log_retention_days
  kms_key_id                  = var.logs_kms_key_arn
  deletion_protection_enabled = true

  tags = merge(var.tags, { "vsp:data-class" = "OPERATIONAL_TELEMETRY" })
}

resource "aws_iam_role" "flow_logs" {
  name                 = "${var.name_prefix}-vpc-flow-logs"
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${var.partition}:ec2:${var.region}:${var.account_id}:vpc-flow-log/*" }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-flow-log-group-only"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
    }]
  })
}

resource "aws_flow_log" "this" {
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60

  tags = var.tags
}
