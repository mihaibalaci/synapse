/**
 * Object Storage Client
 *
 * Abstraction over S3-compatible storage for raw session data.
 * In production: AWS S3. In local dev: MinIO.
 * All raw sessions are stored immutably — never overwritten.
 */

import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'object-storage' });

interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export class ObjectStorageClient {
  private endpoint: string | undefined;
  private region: string;

  constructor() {
    const config = getConfig();
    this.endpoint = config.S3_ENDPOINT;
    this.region = config.S3_REGION;
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
    // In a real implementation, this would use @aws-sdk/client-s3
    // For now, define the interface contract.

    logger.debug({ bucket, key, size: body.length }, 'Storing object');

    // TODO: Replace with actual S3 SDK call
    // const command = new PutObjectCommand({
    //   Bucket: bucket,
    //   Key: key,
    //   Body: body,
    //   ContentType: options?.contentType,
    //   Metadata: options?.metadata,
    // });
    // const response = await this.client.send(command);

    return { key, versionId: undefined };
  }

  /**
   * Retrieve an object by key.
   */
  async getObject(bucket: string, key: string): Promise<{ body: string; metadata: Record<string, string> }> {
    logger.debug({ bucket, key }, 'Retrieving object');

    // TODO: Replace with actual S3 SDK call
    // const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    // const response = await this.client.send(command);

    return { body: '', metadata: {} };
  }

  /**
   * Check if an object exists.
   */
  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      // TODO: HeadObject call
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Generate a pre-signed URL for direct upload from IDE plugins.
   * Useful for large sessions (terminal logs, screenshots).
   */
  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number = 3600,
  ): Promise<string> {
    logger.debug({ bucket, key, expiresInSeconds }, 'Generating presigned URL');

    // TODO: getSignedUrl(client, new PutObjectCommand({...}), { expiresIn })
    return `https://${bucket}.s3.${this.region}.amazonaws.com/${key}?presigned=true`;
  }
}
