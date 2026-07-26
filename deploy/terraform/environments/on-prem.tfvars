# On-prem provisions no cloud resources; Patroni, Redis, and MinIO are
# operated separately and referenced by the Helm on-prem profile.
cloud_provider             = "none"
environment                = "prod"
region                     = "datacenter-1"
kubernetes_cluster_name    = "on-prem-k8s"
domain                     = "recall.internal.example.com"
kubernetes_namespace       = "recall"
kubernetes_service_account = "recall"
