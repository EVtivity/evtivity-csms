// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UPLOAD_URL_EXPIRES_SECONDS, assertUploadSize } from './object-storage.js';
import type { UploadSize, UploadTarget } from './object-storage.js';
import { S3ObjectStorage } from './s3-object-storage.js';
import { createStorageRequestHandler } from './storage-endpoint.js';

/**
 * The headers a Cloudflare R2 upload URL signs besides `host`. R2 checks the
 * signature against the request, so a body of another length (sent with its
 * own Content-Length, or chunked) or another Content-Type is refused with 403
 * SignatureDoesNotMatch; bytes sent past the signed Content-Length are not
 * stored. The live test (r2-live.test.ts) checks this against R2.
 */
export const R2_SIGNED_UPLOAD_HEADERS = ['content-length', 'content-type'] as const;

/**
 * The S3 client of an R2 bucket. `endpoint` is a value validateR2Endpoint
 * accepted (the account's S3 API origin).
 */
export function createR2Client(options: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: options.endpoint,
    // One origin for every bucket, so STORAGE_IMG_SRC names just that host.
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    // A browser PUT sends no checksum, so the upload URL must not sign one
    // (the SDK would add a CRC32 to every presigned PUT by default).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // R2 has one public S3 API host per account, so no private hosts apply.
    requestHandler: createStorageRequestHandler(options.bucket, []),
  });
}

/**
 * `ObjectStorage` for Cloudflare R2. R2 has no form POST upload, so an upload
 * is a presigned PUT of exactly the declared size, never more than `maxBytes`.
 * Everything else is the S3 API, unchanged.
 */
export class R2ObjectStorage extends S3ObjectStorage {
  constructor(client: S3Client, bucket: string) {
    super(client, bucket, 'r2');
  }

  override async createUpload(
    key: string,
    contentType: string,
    size: UploadSize,
  ): Promise<UploadTarget> {
    assertUploadSize(size);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size.size,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_EXPIRES_SECONDS,
      signableHeaders: new Set(R2_SIGNED_UPLOAD_HEADERS),
    });
    // Without both signed headers the URL would take a body of any size or
    // type: refuse to hand it out (a signer that hoisted or dropped them).
    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    if (!R2_SIGNED_UPLOAD_HEADERS.every((header) => signed.includes(header))) {
      throw new Error('The R2 upload URL does not sign Content-Length and Content-Type');
    }
    return { method: 'PUT', url, headers: { 'Content-Type': contentType } };
  }
}
