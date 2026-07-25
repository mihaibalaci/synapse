# ══════════════════════════════════════════════════════════════════════════════
# Recall — Terraform Root Module
#
# Cloud-agnostic infrastructure provisioning.
# Supports AWS, GCP, and Azure via provider selection.
#
# Usage:
#   terraform init
#   terraform plan -var-file=environments/aws-prod.tfvars
#   terraform apply -var-file=environments/aws-prod.tfvars
# ══════════════════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
  }
}

# ─── Variables ────────────────────────────────────────────────────────────────

variable "cloud_provider" {
  description = "Cloud provider: aws | gcp | none (on-prem K8s only)"
  type        = string
  default     = "aws"
}

variable "environment" {
  description = "Environment name: dev | staging | prod"
  type        = string
  default     = "dev"
}

variable "region" {
  description = "Cloud region"
  type        = string
  default     = "us-east-1"
}

variable "kubernetes_cluster_name" {
  description = "Name of the K8s cluster (EKS, GKE, or existing)"
  type        = string
  default     = "recall"
}

variable "postgres_instance_class" {
  description = "Database instance size"
  type        = string
  default     = "db.r6g.xlarge"
}

variable "redis_node_type" {
  description = "Redis node type"
  type        = string
  default     = "cache.r7g.large"
}

variable "domain" {
  description = "Domain for the service"
  type        = string
  default     = "ctx.internal.company.com"
}

# ─── Networking ───────────────────────────────────────────────────────────────

module "networking" {
  source = "./modules/networking"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
}

# ─── PostgreSQL ───────────────────────────────────────────────────────────────

module "postgres" {
  source = "./modules/postgres"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  instance_class = var.postgres_instance_class
  vpc_id         = module.networking.vpc_id
  subnet_ids     = module.networking.private_subnet_ids
  security_group = module.networking.db_security_group_id
}

# ─── Redis ────────────────────────────────────────────────────────────────────

module "redis" {
  source = "./modules/redis"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  node_type      = var.redis_node_type
  vpc_id         = module.networking.vpc_id
  subnet_ids     = module.networking.private_subnet_ids
  security_group = module.networking.redis_security_group_id
}

# ─── Object Storage ──────────────────────────────────────────────────────────

module "storage" {
  source = "./modules/storage"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
}

# ─── Compute (Kubernetes) ─────────────────────────────────────────────────────

module "compute" {
  source = "./modules/compute"

  cloud_provider          = var.cloud_provider
  environment             = var.environment
  region                  = var.region
  cluster_name            = var.kubernetes_cluster_name
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.private_subnet_ids
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "database_endpoint" {
  value     = module.postgres.endpoint
  sensitive = true
}

output "redis_endpoint" {
  value = module.redis.endpoint
}

output "storage_bucket" {
  value = module.storage.bucket_name
}

output "kubernetes_cluster" {
  value = module.compute.cluster_endpoint
}
