# Redis Module — supports AWS ElastiCache, GCP Memorystore, or outputs for on-prem

variable "cloud_provider" { type = string }
variable "environment" { type = string }
variable "node_type" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group" { type = string }

# ─── AWS: ElastiCache ─────────────────────────────────────────────────────────

resource "aws_elasticache_replication_group" "this" {
  count = var.cloud_provider == "aws" ? 1 : 0

  replication_group_id = "recall-${var.environment}"
  description          = "Recall Redis - ${var.environment}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  num_cache_clusters   = var.environment == "prod" ? 3 : 1
  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled     = var.environment == "prod"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name    = aws_elasticache_subnet_group.this[0].name
  security_group_ids   = [var.security_group]

  tags = { Environment = var.environment }
}

resource "aws_elasticache_subnet_group" "this" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  name       = "recall-${var.environment}"
  subnet_ids = var.subnet_ids
}

# ─── GCP: Memorystore ─────────────────────────────────────────────────────────

resource "google_redis_instance" "this" {
  count = var.cloud_provider == "gcp" ? 1 : 0

  name           = "recall-${var.environment}"
  tier           = var.environment == "prod" ? "STANDARD_HA" : "BASIC"
  memory_size_gb = var.environment == "prod" ? 8 : 2
  region         = "us-central1"
  redis_version  = "REDIS_7_0"

  authorized_network = var.vpc_id
  transit_encryption_mode = "SERVER_AUTHENTICATION"
}

# ─── Output ───────────────────────────────────────────────────────────────────

output "endpoint" {
  value = var.cloud_provider == "aws" ? (
    length(aws_elasticache_replication_group.this) > 0 ? aws_elasticache_replication_group.this[0].primary_endpoint_address : ""
  ) : var.cloud_provider == "gcp" ? (
    length(google_redis_instance.this) > 0 ? google_redis_instance.this[0].host : ""
  ) : "redis-service:6379"
}
