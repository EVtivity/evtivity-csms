// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db, drivers, users } from '@evtivity/database';
import {
  DRIVER_AVATAR_DELETE_JOB,
  DRIVER_AVATAR_PURGE_JOB,
  USER_AVATAR_DELETE_JOB,
  USER_AVATAR_PURGE_JOB,
  driverAvatarObjectPrefixes,
  userAvatarObjectPrefixes,
} from '@evtivity/lib/avatar-cleanup';
import type {
  DriverAvatarDeleteJob,
  DriverAvatarPurgeJob,
  UserAvatarDeleteJob,
  UserAvatarPurgeJob,
} from '@evtivity/lib/avatar-cleanup';
import type { ObjectStorage } from './storage/index.js';

/**
 * Avatar objects in storage, shared by the API (erasure, user delete, a failed
 * delete) and the worker (`driver-avatar-cleanup` queue). Every object of a
 * driver lives under `avatars/{driverId}/` (clean images) or
 * `ai-uploads/quarantine/avatars/{driverId}/` (uploads not yet confirmed);
 * every object of a CSMS user under `avatars/users/{userId}/` or
 * `ai-uploads/quarantine/avatars/users/{userId}/`.
 */

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

/**
 * Deletes every object of one driver in the configured bucket and in each of
 * `buckets` (a bucket a driver row named before the setting changed). Throws
 * when storage fails; returns how many objects it deleted.
 */
export async function purgeDriverAvatarObjects(
  storage: ObjectStorage,
  driverId: string,
  buckets: readonly string[] = [],
): Promise<number> {
  let deleted = 0;
  for (const bucket of new Set([storage.bucket, ...buckets])) {
    for (const prefix of driverAvatarObjectPrefixes(driverId)) {
      deleted += await storage.deleteObjectsUnderPrefix(bucket, prefix);
    }
  }
  return deleted;
}

/** The same for one CSMS user. */
export async function purgeUserAvatarObjects(
  storage: ObjectStorage,
  userId: string,
  buckets: readonly string[] = [],
): Promise<number> {
  let deleted = 0;
  for (const bucket of new Set([storage.bucket, ...buckets])) {
    for (const prefix of userAvatarObjectPrefixes(userId)) {
      deleted += await storage.deleteObjectsUnderPrefix(bucket, prefix);
    }
  }
  return deleted;
}

async function runUserAvatarCleanupJob(
  name: string,
  data: unknown,
  storage: ObjectStorage | null,
  log: Logger,
): Promise<boolean> {
  if (name === USER_AVATAR_PURGE_JOB) {
    const job = data as UserAvatarPurgeJob;
    const [user] = await db
      .select({ isActive: users.isActive, avatarKind: users.avatarKind })
      .from(users)
      .where(eq(users.id, job.userId));
    // A user reactivated (or given a new avatar) since the delete keeps its objects.
    if (user != null && (user.isActive || user.avatarKind != null)) {
      log.warn({ userId: job.userId }, 'User avatar purge skipped: the user is active again');
      return true;
    }
    if (storage == null) throw new Error('File storage is not configured');
    const deleted = await purgeUserAvatarObjects(storage, job.userId, job.buckets);
    log.info({ userId: job.userId, deleted }, 'User avatar objects purged');
    return true;
  }
  if (name === USER_AVATAR_DELETE_JOB) {
    const job = data as UserAvatarDeleteJob;
    const [inUse] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.avatarS3Key, job.key), eq(users.avatarS3Bucket, job.bucket)));
    if (inUse != null) {
      log.warn({ key: job.key }, 'User avatar object delete skipped: a user row points at it');
      return true;
    }
    if (storage == null) throw new Error('File storage is not configured');
    await storage.deleteObject(job.bucket, job.key);
    log.info({ userId: job.userId, key: job.key }, 'User avatar object deleted');
    return true;
  }
  return false;
}

/**
 * Runs one job of the `driver-avatar-cleanup` queue (driver and user avatars). Throws when storage is
 * not configured or fails, so the queue retries it. A purge runs only for a
 * driver that is erased or gone, and a delete only for an object no driver row
 * points at, so a late job never removes an avatar in use.
 */
export async function runAvatarCleanupJob(
  name: string,
  data: unknown,
  storage: ObjectStorage | null,
  log: Logger,
): Promise<void> {
  if (name === DRIVER_AVATAR_PURGE_JOB) {
    const job = data as DriverAvatarPurgeJob;
    const [driver] = await db
      .select({ erasedAt: drivers.erasedAt })
      .from(drivers)
      .where(eq(drivers.id, job.driverId));
    if (driver != null && driver.erasedAt == null) {
      log.warn({ driverId: job.driverId }, 'Driver avatar purge skipped: the driver is not erased');
      return;
    }
    if (storage == null) throw new Error('File storage is not configured');
    const deleted = await purgeDriverAvatarObjects(storage, job.driverId, job.buckets);
    log.info({ driverId: job.driverId, deleted }, 'Driver avatar objects purged');
    return;
  }
  if (name === DRIVER_AVATAR_DELETE_JOB) {
    const job = data as DriverAvatarDeleteJob;
    const [inUse] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(and(eq(drivers.avatarS3Key, job.key), eq(drivers.avatarS3Bucket, job.bucket)));
    if (inUse != null) {
      log.warn({ key: job.key }, 'Driver avatar object delete skipped: a driver row points at it');
      return;
    }
    if (storage == null) throw new Error('File storage is not configured');
    await storage.deleteObject(job.bucket, job.key);
    log.info({ driverId: job.driverId, key: job.key }, 'Driver avatar object deleted');
    return;
  }
  if (await runUserAvatarCleanupJob(name, data, storage, log)) return;
  log.warn({ name }, 'Unknown avatar cleanup job dropped');
}
