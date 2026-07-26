variable "cloud_provider" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "gcp_project_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "storage_bucket_arn" {
  type = string
}

variable "storage_bucket_name" {
  type = string
}

variable "kubernetes_namespace" {
  type = string
}

variable "kubernetes_service_account" {
  type = string
}

locals {
  is_aws  = var.cloud_provider == "aws"
  is_gcp  = var.cloud_provider == "gcp"
  is_prod = var.environment == "prod"

  eks_node_policies = local.is_aws ? toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ]) : toset([])

  eks_addons = local.is_aws ? toset(["vpc-cni", "coredns", "kube-proxy"]) : toset([])

  gke_node_roles = local.is_gcp ? toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/artifactregistry.reader",
  ]) : toset([])

  eks_oidc_host = local.is_aws ? replace(aws_iam_openid_connect_provider.eks[0].url, "https://", "") : ""
}

resource "aws_iam_role" "eks" {
  count = local.is_aws ? 1 : 0
  name  = "recall-eks-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  count      = local.is_aws ? 1 : 0
  role       = aws_iam_role.eks[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_kms_key" "eks" {
  count                   = local.is_aws ? 1 : 0
  description             = "Recall EKS secret envelope encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_eks_cluster" "this" {
  count                     = local.is_aws ? 1 : 0
  name                      = var.cluster_name
  role_arn                  = aws_iam_role.eks[0].arn
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = false
  }

  encryption_config {
    resources = ["secrets"]

    provider {
      key_arn = aws_kms_key.eks[0].arn
    }
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

resource "aws_iam_role" "eks_nodes" {
  count = local.is_aws ? 1 : 0
  name  = "recall-eks-nodes-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_nodes" {
  for_each   = local.eks_node_policies
  role       = aws_iam_role.eks_nodes[0].name
  policy_arn = each.value
}

resource "aws_eks_node_group" "workers" {
  count           = local.is_aws ? 1 : 0
  cluster_name    = aws_eks_cluster.this[0].name
  node_group_name = "recall-workers"
  node_role_arn   = aws_iam_role.eks_nodes[0].arn
  subnet_ids      = var.subnet_ids
  instance_types  = [local.is_prod ? "m7i.xlarge" : "m7i.large"]
  capacity_type   = "ON_DEMAND"

  scaling_config {
    desired_size = local.is_prod ? 6 : 2
    max_size     = local.is_prod ? 20 : 6
    min_size     = local.is_prod ? 3 : 1
  }

  update_config {
    max_unavailable_percentage = 25
  }

  depends_on = [aws_iam_role_policy_attachment.eks_nodes]
}

resource "aws_eks_addon" "core" {
  for_each                    = local.eks_addons
  cluster_name                = aws_eks_cluster.this[0].name
  addon_name                  = each.value
  resolve_conflicts_on_update = "PRESERVE"
}

data "tls_certificate" "eks" {
  count = local.is_aws ? 1 : 0
  url   = aws_eks_cluster.this[0].identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  count           = local.is_aws ? 1 : 0
  url             = aws_eks_cluster.this[0].identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks[0].certificates[0].sha1_fingerprint]
}

# IRSA is bound to the exact Recall namespace and service account.
resource "aws_iam_role" "recall" {
  count = local.is_aws ? 1 : 0
  name  = "recall-workload-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.eks[0].arn }
      Condition = {
        StringEquals = {
          "${local.eks_oidc_host}:aud" = "sts.amazonaws.com"
          "${local.eks_oidc_host}:sub" = "system:serviceaccount:${var.kubernetes_namespace}:${var.kubernetes_service_account}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "recall_storage" {
  count = local.is_aws ? 1 : 0
  name  = "recall-object-storage"
  role  = aws_iam_role.recall[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.storage_bucket_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${var.storage_bucket_arn}/*"]
      },
    ]
  })
}

resource "google_service_account" "gke_nodes" {
  count      = local.is_gcp ? 1 : 0
  account_id = "recall-gke-${var.environment}"
  project    = var.gcp_project_id
}

resource "google_project_iam_member" "gke_nodes" {
  for_each = local.gke_node_roles
  project  = var.gcp_project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.gke_nodes[0].email}"
}

resource "google_container_cluster" "this" {
  count                    = local.is_gcp ? 1 : 0
  name                     = var.cluster_name
  location                 = var.region
  network                  = var.vpc_id
  subnetwork               = var.subnet_ids[0]
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = local.is_prod

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.gcp_project_id}.svc.id.goog"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = true
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS", "APISERVER", "SCHEDULER", "CONTROLLER_MANAGER"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS", "APISERVER", "SCHEDULER", "CONTROLLER_MANAGER", "POD", "DEPLOYMENT"]
  }
}

resource "google_container_node_pool" "workers" {
  count    = local.is_gcp ? 1 : 0
  name     = "recall-workers"
  cluster  = google_container_cluster.this[0].name
  location = var.region

  autoscaling {
    min_node_count = local.is_prod ? 3 : 1
    max_node_count = local.is_prod ? 20 : 6
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = local.is_prod ? "n2-standard-4" : "n2-standard-2"
    service_account = google_service_account.gke_nodes[0].email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

resource "google_service_account" "recall" {
  count      = local.is_gcp ? 1 : 0
  account_id = "recall-app-${var.environment}"
  project    = var.gcp_project_id
}

resource "google_service_account_iam_member" "recall_workload_identity" {
  count              = local.is_gcp ? 1 : 0
  service_account_id = google_service_account.recall[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.gcp_project_id}.svc.id.goog[${var.kubernetes_namespace}/${var.kubernetes_service_account}]"
}

resource "google_storage_bucket_iam_member" "recall" {
  count  = local.is_gcp ? 1 : 0
  bucket = var.storage_bucket_name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.recall[0].email}"
}

output "cluster_endpoint" {
  value = local.is_aws ? aws_eks_cluster.this[0].endpoint : (
    local.is_gcp ? google_container_cluster.this[0].endpoint : "existing-cluster"
  )
  sensitive = true
}

output "workload_identity" {
  value = local.is_aws ? aws_iam_role.recall[0].arn : (
    local.is_gcp ? google_service_account.recall[0].email : "external"
  )
  sensitive = true
}
