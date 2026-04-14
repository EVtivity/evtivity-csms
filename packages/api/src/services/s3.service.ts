// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '@evtivity/database';
import { settings } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
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

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

export function clearS3ConfigCache(): void {
  cachedConfig = null;
}

export async function getS3Config(): Promise<S3Config | null> {
  if (cachedConfig != null && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.config;
  }

  const rows = await db.select().from(settings);
  const map = new Map<string, unknown>();
  for (const row of rows) {
    if (row.key.startsWith('s3.')) {
      map.set(row.key, row.value);
    }
  }

  const bucket = map.get('s3.bucket') as string | undefined;
  const region = map.get('s3.region') as string | undefined;
  const accessKeyIdEnc = map.get('s3.accessKeyIdEnc') as string | undefined;
  const secretAccessKeyEnc = map.get('s3.secretAccessKeyEnc') as string | undefined;

  if (bucket == null || region == null || accessKeyIdEnc == null || secretAccessKeyEnc == null) {
    return null;
  }

  const encryptionKey = getEncryptionKey();
  const accessKeyId = decryptString(accessKeyIdEnc, encryptionKey);
  const secretAccessKey = decryptString(secretAccessKeyEnc, encryptionKey);

  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

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

export function buildStationImageS3Key(
  stationId: string,
  fileId: string,
  fileName: string,
): string {
  return `stations/${stationId}/${fileId}-${fileName}`;
}
