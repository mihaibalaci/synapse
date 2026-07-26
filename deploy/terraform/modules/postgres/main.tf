variable "cloud_provider" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "instance_class" {
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

resource "aws_db_subnet_group" "this" {
  count      = local.is_aws ? 1 : 0
  name       = "recall-${var.environment}"
  subnet_ids = var.subnet_ids
}

resource "aws_rds_cluster_parameter_group" "this" {
  count  = local.is_aws ? 1 : 0
  name   = "recall-${var.environment}-aurora-postgresql16"
  family = "aurora-postgresql16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

# Master credentials are managed by AWS and never written to Terraform state.
resource "aws_rds_cluster" "this" {
  count                           = local.is_aws ? 1 : 0
  cluster_identifier              = "recall-${var.environment}"
  engine                          = "aurora-postgresql"
  engine_version                  = "16.4"
  database_name                   = "recall"
  master_username                 = "recall_admin"
  manage_master_user_password     = true
  vpc_security_group_ids          = [var.security_group]
  db_subnet_group_name            = aws_db_subnet_group.this[0].name
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this[0].name
  storage_encrypted               = true
  deletion_protection             = local.is_prod
  backup_retention_period         = local.is_prod ? 35 : 7
  preferred_backup_window         = "03:00-04:00"
  copy_tags_to_snapshot           = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  skip_final_snapshot             = !local.is_prod
  final_snapshot_identifier       = local.is_prod ? "recall-${var.environment}-final" : null
}

resource "aws_rds_cluster_instance" "this" {
  count                      = local.is_aws ? (local.is_prod ? 3 : 1) : 0
  identifier                 = "recall-${var.environment}-${count.index}"
  cluster_identifier         = aws_rds_cluster.this[0].id
  instance_class             = var.instance_class
  engine                     = aws_rds_cluster.this[0].engine
  engine_version             = aws_rds_cluster.this[0].engine_version
  publicly_accessible        = false
  auto_minor_version_upgrade = true
}

resource "random_password" "gcp_admin" {
  count            = local.is_gcp ? 1 : 0
  length           = 40
  special          = true
  override_special = "-_"
}

resource "google_sql_database_instance" "this" {
  count               = local.is_gcp ? 1 : 0
  name                = "recall-${var.environment}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = local.is_prod

  settings {
    tier              = var.instance_class
    availability_type = local.is_prod ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = local.is_prod ? 7 : 3
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.vpc_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
    }
  }
}

resource "google_sql_database" "recall" {
  count    = local.is_gcp ? 1 : 0
  name     = "recall"
  instance = google_sql_database_instance.this[0].name
}

resource "google_sql_user" "admin" {
  count    = local.is_gcp ? 1 : 0
  name     = "recall_admin"
  instance = google_sql_database_instance.this[0].name
  password = random_password.gcp_admin[0].result
}

resource "google_secret_manager_secret" "admin" {
  count     = local.is_gcp ? 1 : 0
  secret_id = "recall-${var.environment}-database-admin"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin" {
  count  = local.is_gcp ? 1 : 0
  secret = google_secret_manager_secret.admin[0].id

  secret_data = jsonencode({
    username = google_sql_user.admin[0].name
    password = random_password.gcp_admin[0].result
    host     = google_sql_database_instance.this[0].private_ip_address
    port     = 5432
    database = google_sql_database.recall[0].name
  })
}

output "endpoint" {
  value = local.is_aws ? aws_rds_cluster.this[0].endpoint : (
    local.is_gcp ? google_sql_database_instance.this[0].private_ip_address : "patroni-primary:5432"
  )
  sensitive = true
}

# The Recall migration Job consumes this secret with the migrator role;
# pgvector/pg_trgm and schema objects are created by migrations, not here.
output "admin_secret_id" {
  value = local.is_aws ? aws_rds_cluster.this[0].master_user_secret[0].secret_arn : (
    local.is_gcp ? google_secret_manager_secret.admin[0].id : "recall-migrator"
  )
  sensitive = true
}
