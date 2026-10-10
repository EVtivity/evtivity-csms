// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { loadS3Config } from '@evtivity/services/s3-storage';
import type { S3Config } from '@evtivity/services/s3-storage';
import { config as apiConfig } from '../lib/config.js';

export { clearS3ConfigCache, deleteObject } from '@evtivity/services/s3-storage';
export type { S3Config } from '@evtivity/services/s3-storage';

/** Presigned upload and download URLs expire after these many seconds. */
export const UPLOAD_URL_EXPIRES_SECONDS = 300;
const DOWNLOAD_URL_EXPIRES_SECONDS = 3600;

/** S3 configuration of this process (5-minute cache), or null when not configured. */
export async function getS3Config(): Promise<S3Config | null> {
  return loadS3Config(apiConfig.SETTINGS_ENCRYPTION_KEY);
}

export async function generateUploadUrl(
  s3: S3Config,
  key: string,
  contentType: string,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: s3.bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3.client, command, { expiresIn: UPLOAD_URL_EXPIRES_SECONDS });
}

export interface UploadPost {
  /** Form POST target. */
  url: string;
  /** Form fields to send before the `file` field, unchanged. */
  fields: Record<string, string>;
}

/**
 * Presigned POST for one object (plan 3.8 step 1). Unlike a presigned PUT, S3
 * itself enforces the policy: exactly this key, this Content-Type, and a body
 * of 1 to `maxBytes` bytes.
 */
export async function generateUploadPost(
  s3: S3Config,
  key: string,
  contentType: string,
  maxBytes: number,
): Promise<UploadPost> {
  return createPresignedPost(s3.client, {
    Bucket: s3.bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_URL_EXPIRES_SECONDS,
  });
}

export interface DownloadOptions {
  /** Served as `Content-Disposition: attachment` with this file name. */
  fileName: string;
  /** Served as the response Content-Type. */
  contentType: string;
}

/**
 * Presigned GET. With `options`, S3 answers with `Content-Disposition:
 * attachment` and the given type, so a browser saves the file instead of
 * rendering it.
 */
export async function generateDownloadUrl(
  s3: S3Config,
  bucket: string,
  key: string,
  options?: DownloadOptions,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(options != null
      ? {
          ResponseContentDisposition: contentDispositionAttachment(options.fileName),
          ResponseContentType: options.contentType,
        }
      : {}),
  });
  return getSignedUrl(s3.client, command, { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS });
}

/** RFC 6266 attachment header with an ASCII fallback and a UTF-8 name. */
export function contentDispositionAttachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export type ReadObjectResult =
  | { status: 'ok'; bytes: Buffer; contentType: string | undefined }
  | { status: 'missing' }
  | { status: 'too_large'; size: number };

/** Read a whole object, refusing one larger than `maxBytes` before downloading it. */
export async function readObject(
  s3: S3Config,
  bucket: string,
  key: string,
  maxBytes: number,
): Promise<ReadObjectResult> {
  try {
    const head = await s3.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const size = head.ContentLength ?? 0;
    if (size > maxBytes) return { status: 'too_large', size };
    const res = await s3.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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

export async function putObject(
  s3: S3Config,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Make a client-supplied file name safe for an S3 key and for display:
 * letters, digits, dot, dash and underscore only, at most 100 characters, no
 * leading dots. S3 keys are opaque, but the name is echoed in API responses,
 * logs and download headers.
 */
export function sanitizeFileName(fileName: string, fallback = 'file'): string {
  const cleaned = fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return cleaned === '' ? fallback : cleaned;
}

/** Key of a confirmed support case attachment. */
export function buildS3Key(
  caseId: string,
  messageId: string | number,
  fileId: string,
  fileName: string,
): string {
  return `support-cases/${caseId}/${String(messageId)}/${fileId}-${sanitizeFileName(fileName)}`;
}

/** Prefix under which uploads wait until confirm checks them (1-day S3 lifecycle rule). */
export const QUARANTINE_PREFIX = 'ai-uploads/quarantine/';

/** Quarantine key of a support case attachment upload. */
export function buildSupportQuarantineKey(
  caseId: string,
  messageId: string | number,
  fileId: string,
  fileName: string,
): string {
  return `${QUARANTINE_PREFIX}support-cases/${caseId}/${String(messageId)}/${fileId}/${sanitizeFileName(fileName)}`;
}

export function buildStationImageS3Key(
  stationId: string,
  fileId: string,
  fileName: string,
): string {
  return `stations/${stationId}/${fileId}-${sanitizeFileName(fileName, 'image')}`;
}
