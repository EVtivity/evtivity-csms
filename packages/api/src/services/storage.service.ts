// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { loadObjectStorage } from '@evtivity/services/storage';
import type { ObjectStorage } from '@evtivity/services/storage';
import { config as apiConfig } from '../lib/config.js';
import { storageOperationsTotal } from '../plugins/metrics.js';

export { clearObjectStorageCache, UPLOAD_URL_EXPIRES_SECONDS } from '@evtivity/services/storage';
export type {
  DownloadOptions,
  ObjectStorage,
  ReadObjectResult,
  UploadTarget,
} from '@evtivity/services/storage';

/** Object storage of this process (5-minute cache), or null when not configured. */
export async function getObjectStorage(): Promise<ObjectStorage | null> {
  const storage = await loadObjectStorage(apiConfig.SETTINGS_ENCRYPTION_KEY);
  return storage == null ? null : measuredStorage(storage);
}

/** One wrapper per loaded storage, so callers get the same object while it is cached. */
const measured = new WeakMap<ObjectStorage, ObjectStorage>();

/**
 * Counts the upload, confirm (read and write) and connection test calls in
 * storage_operations_total by provider and result, so a dashboard shows the
 * failures of each provider. Only the outcome is counted: no key, bucket or
 * error text becomes a label.
 */
export function measuredStorage(storage: ObjectStorage): ObjectStorage {
  const known = measured.get(storage);
  if (known != null) return known;
  const count = async <T>(
    operation: string,
    call: () => Promise<T>,
    resultOf: (value: T) => string = () => 'ok',
  ): Promise<T> => {
    try {
      const value = await call();
      storageOperationsTotal.inc({
        operation,
        provider: storage.provider,
        result: resultOf(value),
      });
      return value;
    } catch (err) {
      storageOperationsTotal.inc({ operation, provider: storage.provider, result: 'error' });
      throw err;
    }
  };
  const wrapper: ObjectStorage = {
    provider: storage.provider,
    bucket: storage.bucket,
    createUpload: (key, contentType, size) =>
      count('create_upload', () => storage.createUpload(key, contentType, size)),
    getDownloadUrl: (bucket, key, options) => storage.getDownloadUrl(bucket, key, options),
    readObject: (bucket, key, maxBytes) =>
      count(
        'read_object',
        () => storage.readObject(bucket, key, maxBytes),
        (r) => r.status,
      ),
    putObject: (bucket, key, body, contentType) =>
      count('put_object', () => storage.putObject(bucket, key, body, contentType)),
    deleteObject: (bucket, key) => count('delete_object', () => storage.deleteObject(bucket, key)),
    deleteObjectsUnderPrefix: (bucket, prefix) =>
      count('delete_prefix', () => storage.deleteObjectsUnderPrefix(bucket, prefix)),
    testConnection: () => count('test_connection', () => storage.testConnection()),
  };
  measured.set(storage, wrapper);
  return wrapper;
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

/** Quarantine key of a station image upload; confirm re-encodes it to the station key. */
export function buildStationImageQuarantineKey(
  stationId: string,
  fileId: string,
  fileName: string,
): string {
  return `${QUARANTINE_PREFIX}stations/${stationId}/${fileId}/${sanitizeFileName(fileName, 'image')}`;
}

export function buildStationImageS3Key(
  stationId: string,
  fileId: string,
  fileName: string,
): string {
  return `stations/${stationId}/${fileId}-${sanitizeFileName(fileName, 'image')}`;
}
