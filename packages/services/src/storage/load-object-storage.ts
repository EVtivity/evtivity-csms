// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { S3Client } from '@aws-sdk/client-s3';
import { like } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { decryptSettingOrNull } from '@evtivity/lib';
import type { ObjectStorage } from './object-storage.js';
import { S3ObjectStorage } from './s3-object-storage.js';

/**
 * The configured object storage, shared by the API and the worker (the
 * worker deletes expired AI attachments and avatars). Settings: `s3.bucket`,
 * `s3.region`, `s3.accessKeyIdEnc`, `s3.secretAccessKeyEnc`.
 */

interface CachedStorage {
  storage: ObjectStorage;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedStorage: CachedStorage | null = null;

export function clearObjectStorageCache(): void {
  cachedStorage = null;
}

/**
 * Read the storage configuration (5-minute cache). Null when storage is not
 * configured. `encryptionKey` is the calling process's SETTINGS_ENCRYPTION_KEY.
 */
export async function loadObjectStorage(encryptionKey: string): Promise<ObjectStorage | null> {
  if (cachedStorage != null && cachedStorage.expiresAt > Date.now()) {
    return cachedStorage.storage;
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
  // stored key is a half-finished configuration, so storage stays disabled.
  const accessKeyId = decryptSettingOrNull(map.get('s3.accessKeyIdEnc'), encryptionKey);
  const secretAccessKey = decryptSettingOrNull(map.get('s3.secretAccessKeyEnc'), encryptionKey);
  if ((accessKeyId == null) !== (secretAccessKey == null)) {
    return null;
  }

  const client =
    accessKeyId != null && secretAccessKey != null
      ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
      : new S3Client({ region });

  const storage = new S3ObjectStorage(client, bucket);
  cachedStorage = { storage, expiresAt: Date.now() + CACHE_TTL_MS };
  return storage;
}
