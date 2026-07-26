/*
 * Object Storage Client
 *
 * Abstraction over S3-compatible storage for raw session data.
 * In production: AWS S3. In local dev: MinIO.
 * All raw sessions are stored immutably — never overwritten.
 */

import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'object-storage' });

interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

function errorDetails(error: unknown): { name?: string; status?: number; message: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const sdkError = error as Error & { $metadata?: { httpStatusCode?: number } };
  return {
    name: sdkError.name,
    status: sdkError.$metadata?.httpStatusCode,
    message: sdkError.message,
  };
}

function isNotFound(error: unknown): boolean {
  const details = errorDetails(error);
  return details.status === 404 || details.name === 'NotFound' || details.name === 'NoSuchKey';
}

function isPreconditionFailure(error: unknown): boolean {
  const details = errorDetails(error);
  return details.status === 412 || details.name === 'PreconditionFailed';
}

async function bodyToString(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');

  const sdkBody = body as { transformToString?: (encoding?: string) => Promise<string> };
  if (typeof sdkBody.transformToString === 'function') {
    return sdkBody.transformToString('utf-8');
  }

  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  throw new Error('S3 returned an unsupported object body type');
}

export class ObjectStorageClient {
  private readonly client: S3Client;

  constructor() {
    const config = getConfig();
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: Boolean(config.S3_ENDPOINT),
    });
  }

  /**
   * Store an object. Immutable — once written, never overwritten.
   */
  async putObject(
    bucket: string,
    key: string,
    body: string | Buffer,
    options?: PutOptions,
  ): Promise<{ key: string; versionId?: string }> {
    logger.debug({ bucket, key, size: Buffer.byteLength(body) }, 'Storing object');

    try {
      const bodyHash = createHash('sha256').update(body).digest('hex');
      const response = await this.client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType,
        Metadata: { ...options?.metadata, contentSha256: bodyHash },
        IfNoneMatch: '*',
      }));
      return { key, versionId: response.VersionId };
    } catch (error) {
      if (isPreconditionFailure(error)) {
        const expectedHash = createHash('sha256').update(body).digest('hex');
        if (expectedHash) {
          const existing = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          const existingHash = existing.Metadata?.contentsha256 ?? existing.Metadata?.contentSha256;
          if (existingHash === expectedHash) return { key, versionId: existing.VersionId };
        }
        throw new Error(`Object s3://${bucket}/${key} already exists and immutable objects cannot be overwritten`, {
          cause: error,
        });
      }
      const details = errorDetails(error);
      throw new Error(`Failed to store s3://${bucket}/${key}: ${details.message}`, { cause: error });
    }
  }

  /**
   * Retrieve an object by key.
   */
  async getObject(bucket: string, key: string): Promise<{ body: string; metadata: Record<string, string> }> {
    logger.debug({ bucket, key }, 'Retrieving object');

    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return {
        body: await bodyToString(response.Body),
        metadata: response.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`Object s3://${bucket}/${key} was not found`, { cause: error });
      }
      const details = errorDetails(error);
      throw new Error(`Failed to retrieve s3://${bucket}/${key}: ${details.message}`, { cause: error });
    }
  }

  /**
   * Check if an object exists.
   */
  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      const details = errorDetails(error);
      throw new Error(`Failed to check s3://${bucket}/${key}: ${details.message}`, { cause: error });
    }
  }

  async checkBucket(bucket: string): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      logger.warn({ err: error, bucket }, 'Object storage health check failed');
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Generate a pre-signed URL for direct immutable upload from IDE plugins.
   */
  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number = 3600,
  ): Promise<string> {
    logger.debug({ bucket, key, expiresInSeconds }, 'Generating presigned URL');

    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: '*' }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      const details = errorDetails(error);
      throw new Error(`Failed to presign upload for s3://${bucket}/${key}: ${details.message}`, {
        cause: error,
      });
    }
  }
}
