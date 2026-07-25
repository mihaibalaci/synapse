# Object Storage Module — S3 (AWS) or GCS (GCP)

variable "cloud_provider" { type = string }
variable "environment" { type = string }
variable "region" { type = string }

# ─── AWS: S3 ──────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = "recall-raw-${var.environment}"
  tags   = { Environment = var.environment }
}

resource "aws_s3_bucket_versioning" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = aws_s3_bucket.this[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = aws_s3_bucket.this[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = aws_s3_bucket.this[0].id

  rule {
    id     = "archive"
    status = "Enabled"
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 365
      storage_class = "GLACIER"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  count                   = var.cloud_provider == "aws" ? 1 : 0
  bucket                  = aws_s3_bucket.this[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ─── GCP: GCS ─────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "this" {
  count    = var.cloud_provider == "gcp" ? 1 : 0
  name     = "recall-raw-${var.environment}"
  location = var.region

  versioning { enabled = true }
  uniform_bucket_level_access = true

  lifecycle_rule {
    action { type = "SetStorageClass" storage_class = "NEARLINE" }
    condition { age = 90 }
  }
  lifecycle_rule {
    action { type = "SetStorageClass" storage_class = "COLDLINE" }
    condition { age = 365 }
  }
}

# ─── Output ───────────────────────────────────────────────────────────────────

output "bucket_name" {
  value = var.cloud_provider == "aws" ? (
    length(aws_s3_bucket.this) > 0 ? aws_s3_bucket.this[0].id : ""
  ) : var.cloud_provider == "gcp" ? (
    length(google_storage_bucket.this) > 0 ? google_storage_bucket.this[0].name : ""
  ) : "minio-bucket"
}
