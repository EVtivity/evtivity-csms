// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The object storage contract the API and the worker use for attachments,
 * station images and avatars. A provider (AWS S3, or an S3-compatible
 * service) implements it; callers never talk to a provider SDK.
 */

/**
 * Which storage integration backs an `ObjectStorage` (setting `s3.provider`):
 * AWS S3, or an S3-compatible service at a custom endpoint (`s3.endpoint`).
 */
export const STORAGE_PROVIDERS = ['s3', 's3-compatible'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** Presigned upload and download URLs expire after these many seconds. */
export const UPLOAD_URL_EXPIRES_SECONDS = 300;
export const DOWNLOAD_URL_EXPIRES_SECONDS = 3600;

/** Where and how a browser uploads one object. */
export interface UploadTarget {
  /** A form POST: the provider enforces the key, the type and the size. */
  method: 'POST';
  /** Form POST target. */
  url: string;
  /** Form fields to send before the `file` field, unchanged. */
  fields: Record<string, string>;
}

export interface DownloadOptions {
  /** Served in `Content-Disposition` with this file name. */
  fileName: string;
  /** Served as the response Content-Type. */
  contentType: string;
  /**
   * `attachment` (the default): a browser saves the file. `inline`: a
   * browser may show it, only for a type that runs no script (a raster image).
   */
  disposition?: 'attachment' | 'inline';
  /** Served as the response `Cache-Control` (provider default when omitted). */
  cacheControl?: string;
}

export type ReadObjectResult =
  | { status: 'ok'; bytes: Buffer; contentType: string | undefined }
  | { status: 'missing' }
  | { status: 'too_large'; size: number };

/**
 * One configured bucket. Reads and deletes name the bucket explicitly, since
 * a row keeps the bucket it was written to after the setting changes.
 */
export interface ObjectStorage {
  readonly provider: StorageProvider;
  /** The bucket new objects are written to. */
  readonly bucket: string;
  /**
   * Presigned upload of one object into `bucket`: exactly `key`, of
   * `contentType`, 1 to `maxBytes` bytes.
   */
  createUpload(key: string, contentType: string, maxBytes: number): Promise<UploadTarget>;
  /**
   * Presigned GET. With `options`, the provider answers with the given type
   * and `Content-Disposition` (attachment unless `inline` is asked for), so a
   * browser never renders the object as the type it was stored with.
   */
  getDownloadUrl(bucket: string, key: string, options?: DownloadOptions): Promise<string>;
  /** Read a whole object, refusing one larger than `maxBytes` before downloading it. */
  readObject(bucket: string, key: string, maxBytes: number): Promise<ReadObjectResult>;
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  /** Delete one object. Succeeds for a key that does not exist. */
  deleteObject(bucket: string, key: string): Promise<void>;
  /**
   * Delete every object under `prefix` (a folder prefix ending in `/`).
   * Throws when a list or a delete fails; returns how many objects it deleted.
   */
  deleteObjectsUnderPrefix(bucket: string, prefix: string): Promise<number>;
  /** Throws when `bucket` cannot be listed with the configured credentials. */
  testConnection(): Promise<void>;
}

function dispositionFileName(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** RFC 6266 attachment header with an ASCII fallback and a UTF-8 name. */
export function contentDispositionAttachment(fileName: string): string {
  return `attachment; ${dispositionFileName(fileName)}`;
}

/** RFC 6266 inline header with an ASCII fallback and a UTF-8 name. */
export function contentDispositionInline(fileName: string): string {
  return `inline; ${dispositionFileName(fileName)}`;
}
