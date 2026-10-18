output "alb_arn" {
  description = "ALB ARN."
  value       = aws_lb.this.arn
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (CloudWatch dimension)."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  description = "ALB DNS name (for the approved hostname's alias record)."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone id."
  value       = aws_lb.this.zone_id
}

output "alb_security_group_id" {
  description = "ALB security group id (the ecs_service module adds the egress rule to the gateway tasks)."
  value       = aws_security_group.alb.id
}

output "target_group_arn" {
  description = "Gateway target group ARN."
  value       = aws_lb_target_group.gateway.arn
}

output "target_group_arn_suffix" {
  description = "Gateway target group ARN suffix (CloudWatch dimension)."
  value       = aws_lb_target_group.gateway.arn_suffix
}

output "web_acl_arn" {
  description = "WAFv2 web ACL ARN."
  value       = aws_wafv2_web_acl.this.arn
}

output "access_log_bucket" {
  description = "ALB access-log bucket name."
  value       = aws_s3_bucket.access_logs.id
}

output "waf_rules" {
  description = "Rendered WAF rules (for review and tests)."
  value       = local.waf_rules
}
