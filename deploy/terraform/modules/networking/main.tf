# Networking Module — VPC/subnets/security groups for AWS or GCP

variable "cloud_provider" { type = string }
variable "environment" { type = string }
variable "region" { type = string }

# ─── AWS VPC ──────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  cidr_block = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags       = { Name = "recall-${var.environment}" }
}

resource "aws_subnet" "private" {
  count             = var.cloud_provider == "aws" ? 3 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet("10.0.0.0/16", 8, count.index + 10)
  availability_zone = "${var.region}${["a", "b", "c"][count.index]}"
  tags              = { Name = "recall-private-${count.index}" }
}

resource "aws_security_group" "db" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  name   = "recall-db-${var.environment}"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_security_group" "redis" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  name   = "recall-redis-${var.environment}"

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

# ─── GCP Network ──────────────────────────────────────────────────────────────

resource "google_compute_network" "this" {
  count                   = var.cloud_provider == "gcp" ? 1 : 0
  name                    = "recall-${var.environment}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "private" {
  count         = var.cloud_provider == "gcp" ? 1 : 0
  name          = "recall-private-${var.environment}"
  network       = google_compute_network.this[0].id
  ip_cidr_range = "10.0.0.0/20"
  region        = var.region
  private_ip_google_access = true
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "vpc_id" {
  value = var.cloud_provider == "aws" ? (
    length(aws_vpc.this) > 0 ? aws_vpc.this[0].id : ""
  ) : var.cloud_provider == "gcp" ? (
    length(google_compute_network.this) > 0 ? google_compute_network.this[0].id : ""
  ) : "on-prem"
}

output "private_subnet_ids" {
  value = var.cloud_provider == "aws" ? aws_subnet.private[*].id : []
}

output "db_security_group_id" {
  value = var.cloud_provider == "aws" ? (
    length(aws_security_group.db) > 0 ? aws_security_group.db[0].id : ""
  ) : ""
}

output "redis_security_group_id" {
  value = var.cloud_provider == "aws" ? (
    length(aws_security_group.redis) > 0 ? aws_security_group.redis[0].id : ""
  ) : ""
}
