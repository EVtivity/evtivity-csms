// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { S3Client } from '@aws-sdk/client-s3';
import { like } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { decryptSettingOrNull } from '@evtivity/lib';
import type { ObjectStorage } from './object-storage.js';
import { S3ObjectStorage } from './s3-object-storage.js';
import {
  createStorageRequestHandler,
  parseStorageAllowedPrivateHosts,
  validateStorageEndpoint,
} from './storage-endpoint.js';

/**
 * The configured object storage, shared by the API and the worker (the
 * worker deletes expired AI attachments and avatars). Settings: `s3.provider`
 * (`s3` when unset), `s3.bucket`, `s3.region`, `s3.accessKeyIdEnc`,
 * `s3.secretAccessKeyEnc`, and for `s3-compatible` also `s3.endpoint`,
 * `s3.forcePathStyle` and `s3.allowedPrivateHosts`.
 */

interface CachedStorage {
  storage: ObjectStorage;
  client: S3Client;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a replaced client keeps its sockets before it is destroyed: a
 * request that took the storage before the swap (an upload read, a batch
 * delete) finishes on it first.
 */
export const RETIRED_CLIENT_GRACE_MS = 2 * 60 * 1000;
let cachedStorage: CachedStorage | null = null;

/**
 * Destroy a client the cache no longer hands out, after the grace period, so
 * its keep-alive agents and sockets do not pile up with each rebuild.
 */
function retireClient(client: S3Client): void {
  const timer = setTimeout(() => {
    client.destroy();
  }, RETIRED_CLIENT_GRACE_MS);
  timer.unref();
}

export function clearObjectStorageCache(): void {
  if (cachedStorage != null) retireClient(cachedStorage.client);
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
  clearObjectStorageCache();

  // Push the s3.* prefix filter to Postgres instead of selecting every
  // settings row and discarding most of them in JS.
  const rows = await db.select().from(settings).where(like(settings.key, 's3.%'));
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  const provider = map.get('s3.provider') ?? 's3';
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

  let client: S3Client;
  let storage: ObjectStorage;
  if (provider === 's3') {
    client =
      accessKeyId != null && secretAccessKey != null
        ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
        : new S3Client({ region });
    storage = new S3ObjectStorage(client, bucket);
  } else if (provider === 's3-compatible') {
    // The credential chain only reaches AWS, so a custom endpoint needs keys.
    // The endpoint is checked again here: the settings route checks it on save,
    // and this covers a value stored any other way.
    const allowedPrivateHosts = parseStorageAllowedPrivateHosts(
      map.get('s3.allowedPrivateHosts') ?? [],
    );
    if (accessKeyId == null || secretAccessKey == null || allowedPrivateHosts == null) {
      return null;
    }
    const endpoint = validateStorageEndpoint(map.get('s3.endpoint'), allowedPrivateHosts);
    if (endpoint == null) return null;
    client = new S3Client({
      region,
      endpoint,
      forcePathStyle: map.get('s3.forcePathStyle') === true,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: createStorageRequestHandler(bucket, allowedPrivateHosts),
    });
    storage = new S3ObjectStorage(client, bucket, 's3-compatible');
  } else {
    return null;
  }

  cachedStorage = { storage, client, expiresAt: Date.now() + CACHE_TTL_MS };
  return storage;
}
