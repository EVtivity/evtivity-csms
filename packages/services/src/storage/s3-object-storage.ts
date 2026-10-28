// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  DOWNLOAD_URL_EXPIRES_SECONDS,
  UPLOAD_URL_EXPIRES_SECONDS,
  contentDispositionAttachment,
  contentDispositionInline,
} from './object-storage.js';
import type {
  DownloadOptions,
  ObjectStorage,
  ReadObjectResult,
  UploadTarget,
} from './object-storage.js';

/** Keys of one multi-object delete (the S3 limit). */
const DELETE_BATCH = 1000;

/** `ObjectStorage` over the S3 API. */
export class S3ObjectStorage implements ObjectStorage {
  readonly provider = 's3' as const;

  constructor(
    readonly client: S3Client,
    readonly bucket: string,
  ) {}

  /**
   * Presigned POST (plan 3.8 step 1). Unlike a presigned PUT, S3 itself
   * enforces the policy: exactly this key, this Content-Type, and a body of
   * 1 to `maxBytes` bytes.
   */
  async createUpload(key: string, contentType: string, maxBytes: number): Promise<UploadTarget> {
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: UPLOAD_URL_EXPIRES_SECONDS,
    });
    return { method: 'POST', url: post.url, fields: post.fields };
  }

  async getDownloadUrl(bucket: string, key: string, options?: DownloadOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options != null
        ? {
            ResponseContentDisposition:
              options.disposition === 'inline'
                ? contentDispositionInline(options.fileName)
                : contentDispositionAttachment(options.fileName),
            ResponseContentType: options.contentType,
            ...(options.cacheControl != null ? { ResponseCacheControl: options.cacheControl } : {}),
          }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS });
  }

  async readObject(bucket: string, key: string, maxBytes: number): Promise<ReadObjectResult> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const size = head.ContentLength ?? 0;
      if (size > maxBytes) return { status: 'too_large', size };
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (res.Body == null) return { status: 'missing' };
      const bytes = Buffer.from(await res.Body.transformToByteArray());
      if (bytes.length > maxBytes) return { status: 'too_large', size: bytes.length };
      return { status: 'ok', bytes, contentType: res.ContentType };
    } catch (err) {
      // HeadObject reports a missing key as NotFound, GetObject as NoSuchKey.
      if (err instanceof NoSuchKey || err instanceof NotFound) return { status: 'missing' };
      throw err;
    }
  }

  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** S3 answers success for a key that does not exist. */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * Lists a page (at most 1000 keys), then deletes it in one batch, until the
   * listing is empty. Also throws when S3 reports a key it could not delete.
   */
  async deleteObjectsUnderPrefix(bucket: string, prefix: string): Promise<number> {
    if (prefix === '' || !prefix.endsWith('/')) {
      throw new Error('deleteObjectsUnderPrefix needs a folder prefix ending in /');
    }
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH,
          ...(continuationToken != null ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key != null && key.startsWith(prefix));
      if (keys.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errors = result.Errors ?? [];
        if (errors.length > 0) {
          throw new Error(
            `S3 could not delete ${String(errors.length)} object(s) under ${prefix}: ${errors[0]?.Code ?? 'unknown'}`,
          );
        }
        deleted += keys.length;
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken != null);
    return deleted;
  }

  async testConnection(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }
}
