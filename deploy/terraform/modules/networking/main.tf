variable "cloud_provider" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

locals {
  azs       = ["${var.region}a", "${var.region}b", "${var.region}c"]
  is_aws    = var.cloud_provider == "aws"
  is_gcp    = var.cloud_provider == "gcp"
  nat_count = var.environment == "prod" ? 3 : 1
}

resource "aws_vpc" "this" {
  count                = local.is_aws ? 1 : 0
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "recall-${var.environment}"
  }
}

resource "aws_internet_gateway" "this" {
  count  = local.is_aws ? 1 : 0
  vpc_id = aws_vpc.this[0].id
}

resource "aws_subnet" "public" {
  count                   = local.is_aws ? 3 : 0
  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = cidrsubnet("10.0.0.0/16", 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name                     = "recall-public-${count.index}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count             = local.is_aws ? 3 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet("10.0.0.0/16", 8, count.index + 10)
  availability_zone = local.azs[count.index]

  tags = {
    Name                              = "recall-private-${count.index}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_eip" "nat" {
  count      = local.is_aws ? local.nat_count : 0
  domain     = "vpc"
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count         = local.is_aws ? local.nat_count : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  count  = local.is_aws ? 1 : 0
  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }
}

resource "aws_route_table_association" "public" {
  count          = local.is_aws ? 3 : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "private" {
  count  = local.is_aws ? 3 : 0
  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[min(count.index, local.nat_count - 1)].id
  }
}

resource "aws_route_table_association" "private" {
  count          = local.is_aws ? 3 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_security_group" "db" {
  count       = local.is_aws ? 1 : 0
  name        = "recall-db-${var.environment}"
  description = "Recall PostgreSQL access"
  vpc_id      = aws_vpc.this[0].id

  ingress {
    description = "PostgreSQL from inside the VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.this[0].cidr_block]
  }
}

resource "aws_security_group" "redis" {
  count       = local.is_aws ? 1 : 0
  name        = "recall-redis-${var.environment}"
  description = "Recall Redis access"
  vpc_id      = aws_vpc.this[0].id

  ingress {
    description = "Redis from inside the VPC"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.this[0].cidr_block]
  }
}

resource "google_compute_network" "this" {
  count                   = local.is_gcp ? 1 : 0
  name                    = "recall-${var.environment}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "private" {
  count                    = local.is_gcp ? 1 : 0
  name                     = "recall-private-${var.environment}"
  network                  = google_compute_network.this[0].id
  ip_cidr_range            = "10.0.0.0/20"
  region                   = var.region
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.16.0.0/14"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.20.0.0/20"
  }
}

# Cloud SQL and Memorystore require an allocated range plus a peering
# connection before private IPs can be assigned.
resource "google_compute_global_address" "private_services" {
  count         = local.is_gcp ? 1 : 0
  name          = "recall-private-services-${var.environment}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.this[0].id
}

resource "google_service_networking_connection" "private_services" {
  count                   = local.is_gcp ? 1 : 0
  network                 = google_compute_network.this[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[0].name]
}

output "vpc_id" {
  value = local.is_aws ? aws_vpc.this[0].id : (
    local.is_gcp ? google_compute_network.this[0].id : "on-prem"
  )
}

output "private_subnet_ids" {
  value = local.is_aws ? aws_subnet.private[*].id : (
    local.is_gcp ? [google_compute_subnetwork.private[0].id] : []
  )
}

output "db_security_group_id" {
  value = local.is_aws ? aws_security_group.db[0].id : ""
}

output "redis_security_group_id" {
  value = local.is_aws ? aws_security_group.redis[0].id : ""
}

output "private_services_connection" {
  value = local.is_gcp ? google_service_networking_connection.private_services[0].id : ""
}
