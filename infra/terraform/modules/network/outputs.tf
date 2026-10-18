output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnets (ALB and NAT only)."
  value       = [for az in var.availability_zones : aws_subnet.public[az].id]
}

output "app_subnet_ids" {
  description = "Private application subnets."
  value       = [for az in var.availability_zones : aws_subnet.app[az].id]
}

output "data_subnet_ids" {
  description = "Private data subnets (no internet route)."
  value       = [for az in var.availability_zones : aws_subnet.data[az].id]
}

output "endpoint_security_group_id" {
  description = "Security group of the interface endpoints."
  value       = aws_security_group.endpoints.id
}

output "s3_prefix_list_id" {
  description = "Prefix list of the S3 gateway endpoint (for security-group egress rules)."
  value       = aws_vpc_endpoint.gateway["s3"].prefix_list_id
}

output "dynamodb_prefix_list_id" {
  description = "Prefix list of the DynamoDB gateway endpoint."
  value       = aws_vpc_endpoint.gateway["dynamodb"].prefix_list_id
}

output "nat_public_ips" {
  description = "Egress IPs (for vendor-side supplemental allowlists; not authentication)."
  value       = [for e in aws_eip.nat : e.public_ip]
}

output "flow_log_group_name" {
  description = "Flow log group name."
  value       = aws_cloudwatch_log_group.flow_logs.name
}
