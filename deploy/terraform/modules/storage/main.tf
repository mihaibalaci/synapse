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

# Bucket namespaces are global, so a random suffix avoids cross-account collisions.
resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "this" {
  count         = var.cloud_provider == "aws" ? 1 : 0
  bucket        = "recall-raw-${var.environment}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = aws_s3_bucket.this[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  count  = var.cloud_provider == "aws" ? 1 : 0
  bucket = aws_s3_bucket.this[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
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

# Raw sessions are audit evidence: current versions stay immediately readable and
# only superseded versions are tiered to colder storage.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  bucket     = aws_s3_bucket.this[0].id
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "archive-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_transition {
      noncurrent_days = 365
      storage_class   = "GLACIER"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "google_storage_bucket" "this" {
  count                       = var.cloud_provider == "gcp" ? 1 : 0
  name                        = "recall-raw-${var.environment}-${random_id.suffix.hex}"
  project                     = var.gcp_project_id
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }

    condition {
      age                = 90
      with_state         = "ARCHIVED"
      num_newer_versions = 1
    }
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }

    condition {
      age                = 365
      with_state         = "ARCHIVED"
      num_newer_versions = 1
    }
  }
}

output "bucket_name" {
  value = var.cloud_provider == "aws" ? aws_s3_bucket.this[0].id : (
    var.cloud_provider == "gcp" ? google_storage_bucket.this[0].name : "recall-raw"
  )
}

output "bucket_arn" {
  value = var.cloud_provider == "aws" ? aws_s3_bucket.this[0].arn : (
    var.cloud_provider == "gcp" ? "projects/_/buckets/${google_storage_bucket.this[0].name}" : ""
  )
}
