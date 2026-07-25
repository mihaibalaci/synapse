# Compute Module — EKS (AWS), GKE (GCP), or skip for existing K8s

variable "cloud_provider" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "cluster_name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }

# ─── AWS: EKS ─────────────────────────────────────────────────────────────────

resource "aws_eks_cluster" "this" {
  count    = var.cloud_provider == "aws" ? 1 : 0
  name     = var.cluster_name
  role_arn = aws_iam_role.eks[0].arn

  vpc_config {
    subnet_ids = var.subnet_ids
  }

  tags = { Environment = var.environment }
}

resource "aws_iam_role" "eks" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = "recall-eks-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks[0].name
}

resource "aws_eks_node_group" "workers" {
  count           = var.cloud_provider == "aws" ? 1 : 0
  cluster_name    = aws_eks_cluster.this[0].name
  node_group_name = "recall-workers"
  node_role_arn   = aws_iam_role.eks_nodes[0].arn
  subnet_ids      = var.subnet_ids

  scaling_config {
    desired_size = var.environment == "prod" ? 6 : 3
    max_size     = var.environment == "prod" ? 20 : 6
    min_size     = var.environment == "prod" ? 3 : 1
  }

  instance_types = [var.environment == "prod" ? "m6i.xlarge" : "m6i.large"]
}

resource "aws_iam_role" "eks_nodes" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = "recall-eks-nodes-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# ─── GCP: GKE ─────────────────────────────────────────────────────────────────

resource "google_container_cluster" "this" {
  count    = var.cloud_provider == "gcp" ? 1 : 0
  name     = var.cluster_name
  location = var.region

  initial_node_count       = 1
  remove_default_node_pool = true
  network                  = var.vpc_id

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
}

resource "google_container_node_pool" "workers" {
  count      = var.cloud_provider == "gcp" ? 1 : 0
  name       = "recall-workers"
  cluster    = google_container_cluster.this[0].name
  location   = var.region

  autoscaling {
    min_node_count = var.environment == "prod" ? 3 : 1
    max_node_count = var.environment == "prod" ? 20 : 6
  }

  node_config {
    machine_type = var.environment == "prod" ? "n2-standard-4" : "n2-standard-2"
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "cluster_endpoint" {
  value = var.cloud_provider == "aws" ? (
    length(aws_eks_cluster.this) > 0 ? aws_eks_cluster.this[0].endpoint : ""
  ) : var.cloud_provider == "gcp" ? (
    length(google_container_cluster.this) > 0 ? google_container_cluster.this[0].endpoint : ""
  ) : "existing-cluster"
}
