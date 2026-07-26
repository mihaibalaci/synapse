terraform {
  required_version = ">= 1.8.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
    google = {
      source  = "hashicorp/google"
      version = "6.32.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.7.2"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.1.0"
    }
  }
}

variable "cloud_provider" {
  type = string

  validation {
    condition     = contains(["aws", "gcp", "none"], var.cloud_provider)
    error_message = "cloud_provider must be aws, gcp, or none."
  }
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "gcp_project_id" {
  type    = string
  default = ""
}

variable "kubernetes_cluster_name" {
  type = string
}

variable "postgres_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "redis_node_type" {
  type    = string
  default = "cache.r7g.large"
}

variable "domain" {
  type    = string
  default = "recall.internal.example.com"
}

variable "kubernetes_namespace" {
  type    = string
  default = "recall"
}

variable "kubernetes_service_account" {
  type    = string
  default = "recall"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = "recall"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.region
}

module "networking" {
  source = "./modules/networking"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
}

module "postgres" {
  source = "./modules/postgres"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
  instance_class = var.postgres_instance_class
  vpc_id         = module.networking.vpc_id
  subnet_ids     = module.networking.private_subnet_ids
  security_group = module.networking.db_security_group_id
}

module "redis" {
  source = "./modules/redis"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
  node_type      = var.redis_node_type
  vpc_id         = module.networking.vpc_id
  subnet_ids     = module.networking.private_subnet_ids
  security_group = module.networking.redis_security_group_id
}

module "storage" {
  source = "./modules/storage"

  cloud_provider = var.cloud_provider
  environment    = var.environment
  region         = var.region
  gcp_project_id = var.gcp_project_id
}

module "compute" {
  source = "./modules/compute"

  cloud_provider             = var.cloud_provider
  environment                = var.environment
  region                     = var.region
  gcp_project_id             = var.gcp_project_id
  cluster_name               = var.kubernetes_cluster_name
  vpc_id                     = module.networking.vpc_id
  subnet_ids                 = module.networking.private_subnet_ids
  storage_bucket_arn         = module.storage.bucket_arn
  storage_bucket_name        = module.storage.bucket_name
  kubernetes_namespace       = var.kubernetes_namespace
  kubernetes_service_account = var.kubernetes_service_account
}

output "database_endpoint" {
  value     = module.postgres.endpoint
  sensitive = true
}

output "database_admin_secret" {
  value     = module.postgres.admin_secret_id
  sensitive = true
}

output "redis_endpoint" {
  value     = module.redis.endpoint
  sensitive = true
}

output "redis_auth_secret" {
  value     = module.redis.auth_secret
  sensitive = true
}

output "storage_bucket" {
  value = module.storage.bucket_name
}

output "kubernetes_cluster" {
  value     = module.compute.cluster_endpoint
  sensitive = true
}

output "workload_identity" {
  value     = module.compute.workload_identity
  sensitive = true
}

output "domain" {
  value = var.domain
}
