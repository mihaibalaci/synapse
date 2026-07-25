# PostgreSQL Module — supports AWS RDS/Aurora, GCP Cloud SQL, or outputs for on-prem

variable "cloud_provider" { type = string }
variable "environment" { type = string }
variable "instance_class" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group" { type = string }

# ─── AWS: Aurora PostgreSQL ───────────────────────────────────────────────────

resource "aws_rds_cluster" "this" {
  count = var.cloud_provider == "aws" ? 1 : 0

  cluster_identifier     = "recall-${var.environment}"
  engine                 = "aurora-postgresql"
  engine_version         = "16.1"
  database_name          = "recall"
  master_username        = "postgres"
  master_password        = random_password.db[0].result
  vpc_security_group_ids = [var.security_group]
  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  storage_encrypted      = true
  deletion_protection    = var.environment == "prod"
  backup_retention_period = var.environment == "prod" ? 30 : 7

  tags = { Environment = var.environment }
}

resource "aws_rds_cluster_instance" "writer" {
  count = var.cloud_provider == "aws" ? 1 : 0

  identifier         = "recall-${var.environment}-writer"
  cluster_identifier = aws_rds_cluster.this[0].id
  instance_class     = var.instance_class
  engine             = "aurora-postgresql"
}

resource "aws_rds_cluster_instance" "reader" {
  count = var.cloud_provider == "aws" && var.environment == "prod" ? 2 : 0

  identifier         = "recall-${var.environment}-reader-${count.index}"
  cluster_identifier = aws_rds_cluster.this[0].id
  instance_class     = var.instance_class
  engine             = "aurora-postgresql"
}

resource "aws_db_subnet_group" "this" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  name       = "recall-${var.environment}"
  subnet_ids = var.subnet_ids
}

resource "random_password" "db" {
  count   = var.cloud_provider == "aws" ? 1 : 0
  length  = 32
  special = false
}

# ─── GCP: Cloud SQL ───────────────────────────────────────────────────────────

resource "google_sql_database_instance" "this" {
  count = var.cloud_provider == "gcp" ? 1 : 0

  name             = "recall-${var.environment}"
  database_version = "POSTGRES_16"
  region           = "us-central1"

  settings {
    tier              = "db-custom-4-16384"
    availability_type = var.environment == "prod" ? "REGIONAL" : "ZONAL"

    database_flags {
      name  = "cloudsql.enable_pgvector"
      value = "on"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.vpc_id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  deletion_protection = var.environment == "prod"
}

# ─── Output ───────────────────────────────────────────────────────────────────

output "endpoint" {
  value = var.cloud_provider == "aws" ? (
    length(aws_rds_cluster.this) > 0 ? aws_rds_cluster.this[0].endpoint : ""
  ) : var.cloud_provider == "gcp" ? (
    length(google_sql_database_instance.this) > 0 ? google_sql_database_instance.this[0].private_ip_address : ""
  ) : "patroni-service:5432"
}
