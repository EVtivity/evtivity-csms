// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { like } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { settings } from '@evtivity/database';
import { decryptSettingOrNull } from '@evtivity/lib';
import { config as apiConfig } from '../lib/config.js';

export interface S3Config {
  client: S3Client;
  bucket: string;
}

interface CachedConfig {
  config: S3Config;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedConfig: CachedConfig | null = null;

export function clearS3ConfigCache(): void {
  cachedConfig = null;
}

export async function getS3Config(): Promise<S3Config | null> {
  if (cachedConfig != null && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.config;
  }

  // Push the s3.* prefix filter to Postgres instead of selecting every
  // settings row and discarding most of them in JS.
  const rows = await db.select().from(settings).where(like(settings.key, 's3.%'));
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  const bucket = map.get('s3.bucket') as string | undefined;
  const region = map.get('s3.region') as string | undefined;
  // A cleared field is stored as an empty string: not configured.
  if (bucket == null || bucket === '' || region == null || region === '') {
    return null;
  }
  // No stored keys (no row, or the empty string the seed and a cleared field
  // store) means use the default credential chain (the ECS task role). A single
  // stored key is a half-finished configuration, so S3 stays disabled.
  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  const accessKeyId = decryptSettingOrNull(map.get('s3.accessKeyIdEnc'), encryptionKey);
  const secretAccessKey = decryptSettingOrNull(map.get('s3.secretAccessKeyEnc'), encryptionKey);
  if ((accessKeyId == null) !== (secretAccessKey == null)) {
    return null;
  }

  const client =
    accessKeyId != null && secretAccessKey != null
      ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
      : new S3Client({ region });

  const config: S3Config = { client, bucket };
  cachedConfig = { config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
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
  return getSignedUrl(s3.client, command, { expiresIn: 300 });
}

export async function generateDownloadUrl(
  s3: S3Config,
  bucket: string,
  key: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3.client, command, { expiresIn: 3600 });
}

export async function deleteObject(s3: S3Config, bucket: string, key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  await s3.client.send(command);
}

export function buildS3Key(
  caseId: string,
  messageId: string | number,
  fileId: string,
  fileName: string,
): string {
  return `support-cases/${caseId}/${String(messageId)}/${fileId}-${fileName}`;
}

// Strip any path separators or other shenanigans from the client-supplied
// fileName before it becomes part of the S3 key. S3 treats keys as opaque
// strings so a traversal attempt like '../../secret' is harmless to the
// bucket itself, but the fileName is echoed back in API responses and
// displayed in the portal UI - sanitising here keeps logs and stored
// metadata clean.
function sanitizeImageFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'image';
}

export function buildStationImageS3Key(
  stationId: string,
  fileId: string,
  fileName: string,
): string {
  return `stations/${stationId}/${fileId}-${sanitizeImageFileName(fileName)}`;
}
