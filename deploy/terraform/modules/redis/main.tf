variable "cloud_provider" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "node_type" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group" {
  type = string
}

locals {
  is_aws  = var.cloud_provider == "aws"
  is_gcp  = var.cloud_provider == "gcp"
  is_prod = var.environment == "prod"
}

resource "aws_elasticache_subnet_group" "this" {
  count      = local.is_aws ? 1 : 0
  name       = "recall-${var.environment}"
  subnet_ids = var.subnet_ids
}

# BullMQ state must never be evicted, so eviction is disabled explicitly.
resource "aws_elasticache_parameter_group" "this" {
  count  = local.is_aws ? 1 : 0
  name   = "recall-${var.environment}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "this" {
  count                      = local.is_aws ? 1 : 0
  replication_group_id       = "recall-${var.environment}"
  description                = "Recall queue and cache Redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.node_type
  num_cache_clusters         = local.is_prod ? 3 : 1
  automatic_failover_enabled = local.is_prod
  multi_az_enabled           = local.is_prod
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  subnet_group_name          = aws_elasticache_subnet_group.this[0].name
  security_group_ids         = [var.security_group]
  parameter_group_name       = aws_elasticache_parameter_group.this[0].name
  snapshot_retention_limit   = local.is_prod ? 14 : 1
  snapshot_window            = "04:00-05:00"
  auto_minor_version_upgrade = true
}

resource "google_redis_instance" "this" {
  count                   = local.is_gcp ? 1 : 0
  name                    = "recall-${var.environment}"
  tier                    = local.is_prod ? "STANDARD_HA" : "BASIC"
  memory_size_gb          = local.is_prod ? 8 : 2
  region                  = var.region
  redis_version           = "REDIS_7_2"
  authorized_network      = var.vpc_id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  auth_enabled            = true

  redis_configs = {
    maxmemory-policy = "noeviction"
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"

      start_time {
        hours = 5
      }
    }
  }
}

# Recall connects over TLS, so callers must use the rediss:// scheme.
output "endpoint" {
  value = local.is_aws ? "rediss://${aws_elasticache_replication_group.this[0].primary_endpoint_address}:6379" : (
    local.is_gcp ? "rediss://${google_redis_instance.this[0].host}:${google_redis_instance.this[0].port}" : "rediss://redis-primary:6379"
  )
  sensitive = true
}

output "auth_secret" {
  value     = local.is_gcp ? google_redis_instance.this[0].auth_string : ""
  sensitive = true
}
