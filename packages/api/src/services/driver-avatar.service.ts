// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, drivers, driverAuditLog, writeAudit } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { generatedAvatarProblem } from '@evtivity/lib/account-avatar';
import type { GeneratedAvatar } from '@evtivity/lib/account-avatar';
import {
  enqueueDriverAvatarObjectDelete,
  enqueueDriverAvatarPurge,
} from '@evtivity/lib/avatar-cleanup';
import { purgeDriverAvatarObjects } from '@evtivity/services/avatar-storage';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import type { ObjectStorage } from './storage.service.js';
import {
  avatarChanged,
  avatarRowOf,
  getObjectStorageOrNull,
  storedAvatarObject,
} from './account-avatar.js';
import type { AvatarRow, AvatarValues, StoredAvatarObject } from './account-avatar.js';
import {
  avatarCleanKeyPrefix,
  finalizeAvatar,
  parseAvatarQuarantineKey,
} from './account-avatar-upload.js';
import type { AvatarUploader } from './account-avatar-upload.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The only writer of `drivers.avatar_*` (P3). A driver has one avatar at a
 * time: a generated one (DiceBear options) or an uploaded image (a clean S3
 * object). The driver sets or removes it (portal, app, the registration
 * form), and so does an operator with `drivers:write` (`/v1/drivers/:id/avatar`,
 * audited in the operator's name). Setting one replaces the other; the row is written
 * first, then the previous image object is deleted, so a lost delete leaves an
 * orphan object, never a row pointing at a deleted object (P4). A delete that
 * fails is queued on the `driver-avatar-cleanup` worker queue (retried with
 * backoff).
 */

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

export interface AvatarContext {
  actor: AuditActorInfo;
  log: Logger;
  /** Audit note; "Avatar changed by the driver" by default. */
  note?: string;
}

/** A write and whether it changed the avatar (an unchanged write stores and audits nothing). */
export interface AvatarWriteResult {
  avatar: AvatarRow;
  changed: boolean;
}

/** The avatar columns a driver read selects and `avatarView` turns into the reply. */
export const driverAvatarColumns = {
  avatarKind: drivers.avatarKind,
  avatarOptions: drivers.avatarOptions,
  avatarS3Key: drivers.avatarS3Key,
  avatarS3Bucket: drivers.avatarS3Bucket,
  avatarUpdatedAt: drivers.avatarUpdatedAt,
};

/**
 * Deletes a driver avatar object no row points at any more. When storage is
 * not configured or the delete fails, the delete is queued for the worker
 * (`driver-avatar-cleanup`, retried with backoff); a failed queue write is
 * logged and the object stays (fail-open, P9).
 */
export async function deleteAvatarObject(
  driverId: string,
  object: StoredAvatarObject | null,
  log: Logger,
): Promise<void> {
  if (object == null) return;
  const storage = await getObjectStorageOrNull();
  if (storage != null) {
    try {
      await storage.deleteObject(object.bucket, object.key);
      return;
    } catch (err) {
      log.warn({ err, key: object.key }, 'driver avatar object delete failed, queued');
    }
  } else {
    log.warn({ key: object.key }, 'driver avatar object delete queued: S3 is not configured');
  }
  try {
    await enqueueDriverAvatarObjectDelete({ driverId, bucket: object.bucket, key: object.key });
  } catch (err) {
    log.warn({ err, key: object.key }, 'driver avatar object delete could not be queued');
  }
}

/**
 * Deletes every object of an erased driver: the current image, images earlier
 * failed deletes left and unconfirmed uploads (`avatars/{driverId}/`,
 * `ai-uploads/quarantine/avatars/{driverId}/`). When storage fails, or is not
 * configured while the row named an image, the purge is queued for the worker
 * (fail-open, logged). Returns how many objects it deleted now.
 */
export async function purgeDriverAvatarStorage(
  driverId: string,
  rowBucket: string | null,
  log: Logger,
): Promise<number> {
  const buckets = rowBucket != null ? [rowBucket] : [];
  const storage = await getObjectStorageOrNull();
  if (storage == null && rowBucket == null) return 0;
  if (storage != null) {
    try {
      return await purgeDriverAvatarObjects(storage, driverId, buckets);
    } catch (err) {
      log.warn({ err, driverId }, 'driver avatar purge failed, queued');
    }
  } else {
    log.warn({ driverId }, 'driver avatar purge queued: S3 is not configured');
  }
  try {
    await enqueueDriverAvatarPurge({ driverId, buckets });
  } catch (err) {
    log.warn({ err, driverId }, 'driver avatar purge could not be queued');
  }
  return 0;
}

function driverNotFound(): AppError {
  return new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
}

/**
 * Locks the driver row, writes the avatar, returns the previous and the new
 * columns. A write that changes nothing leaves the row as it is.
 */
async function writeAvatar(
  driverId: string,
  next: AvatarValues,
): Promise<{ before: AvatarRow; after: AvatarRow }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...driverAvatarColumns, erasedAt: drivers.erasedAt })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .for('update');
    if (locked == null) throw driverNotFound();
    if (locked.erasedAt != null) throw new AppError('The driver was erased', 409, 'DRIVER_ERASED');
    const before = avatarRowOf(locked);
    if (!avatarChanged(before, next)) return { before, after: before };
    const [after] = await tx
      .update(drivers)
      .set({ ...next, avatarUpdatedAt: next.avatarKind == null ? null : new Date() })
      .where(eq(drivers.id, driverId))
      .returning(driverAvatarColumns);
    if (after == null) throw driverNotFound();
    return { before, after };
  });
}

/** After the commit: delete the replaced image and audit the change (kinds only, no key or options). */
async function afterWrite(
  driverId: string,
  result: { before: AvatarRow; after: AvatarRow },
  ctx: AvatarContext,
): Promise<boolean> {
  if (!avatarChanged(result.before, result.after)) return false;
  const previous = storedAvatarObject(result.before);
  if (previous != null && previous.key !== result.after.avatarS3Key) {
    await deleteAvatarObject(driverId, previous, ctx.log);
  }
  await writeAudit(
    { table: driverAuditLog, idColumn: 'driver_id' },
    {
      entityId: driverId,
      entityIdSnapshot: driverId,
      action: 'updated',
      ...ctx.actor,
      before: { avatar: result.before.avatarKind },
      after: { avatar: result.after.avatarKind },
      notes: ctx.note ?? 'Avatar changed by the driver',
    },
    db,
    ctx.log,
  );
  return true;
}

/**
 * Sets a generated avatar. Throws 400 `VALIDATION_ERROR` when it is not on the
 * allow-list. The same avatar again changes nothing (no write, no audit).
 */
export async function setGeneratedAvatar(
  driverId: string,
  avatar: unknown,
  ctx: AvatarContext,
): Promise<AvatarWriteResult> {
  const problem = generatedAvatarProblem(avatar);
  if (problem != null) throw new AppError(problem, 400, 'VALIDATION_ERROR');
  const valid = avatar as GeneratedAvatar;
  const result = await writeAvatar(driverId, {
    avatarKind: 'generated',
    avatarOptions: { style: valid.style, seed: valid.seed, options: valid.options },
    avatarS3Key: null,
    avatarS3Bucket: null,
  });
  return { avatar: result.after, changed: await afterWrite(driverId, result, ctx) };
}

/**
 * The avatar columns of a driver whose avatar can change: 404
 * `DRIVER_NOT_FOUND` for an unknown driver, 409 `DRIVER_ERASED` for an erased
 * one. Checked before an upload is read.
 */
export async function writableAvatarRow(driverId: string): Promise<AvatarRow> {
  const [row] = await db
    .select({ ...driverAvatarColumns, erasedAt: drivers.erasedAt })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (row == null) throw driverNotFound();
  if (row.erasedAt != null) throw new AppError('The driver was erased', 409, 'DRIVER_ERASED');
  return avatarRowOf(row);
}

/**
 * Confirms an uploaded avatar: the quarantine key must be one issued for this
 * driver to this uploader (the driver, or the operator principal in
 * `ctx.uploader`) and the bucket the configured one (else 400
 * `VALIDATION_ERROR`, nothing read from S3). A retry of a confirmed key
 * returns the current avatar.
 */
export async function confirmUploadedAvatar(
  driverId: string,
  storage: ObjectStorage,
  upload: { s3Key: string; s3Bucket: string },
  ctx: AvatarContext & { log: FastifyBaseLogger; uploader?: AvatarUploader },
): Promise<AvatarRow> {
  const target = { kind: 'driver', driverId } as const;
  const fileId = parseAvatarQuarantineKey(target, upload.s3Key, ctx.uploader);
  if (fileId == null || upload.s3Bucket !== storage.bucket) {
    throw new AppError(
      'The image key or bucket does not belong to this driver',
      400,
      'VALIDATION_ERROR',
    );
  }
  const current = await writableAvatarRow(driverId);
  if (current.avatarS3Key?.startsWith(avatarCleanKeyPrefix(target, fileId)) === true) {
    return current;
  }

  const stored = await finalizeAvatar(storage, target, upload.s3Key, fileId, ctx.log);
  let result;
  try {
    result = await writeAvatar(driverId, {
      avatarKind: 'image',
      avatarOptions: null,
      avatarS3Key: stored.s3Key,
      avatarS3Bucket: storage.bucket,
    });
  } catch (err) {
    await deleteAvatarObject(driverId, { key: stored.s3Key, bucket: storage.bucket }, ctx.log);
    throw err;
  }
  await afterWrite(driverId, result, ctx);
  return result.after;
}

/**
 * Removes the avatar (the driver then shows initials). Idempotent: removing no
 * avatar changes nothing. Returns whether there was one.
 */
export async function removeAvatar(driverId: string, ctx: AvatarContext): Promise<boolean> {
  const result = await writeAvatar(driverId, {
    avatarKind: null,
    avatarOptions: null,
    avatarS3Key: null,
    avatarS3Bucket: null,
  });
  return afterWrite(driverId, result, ctx);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Clears the avatar inside the erasure transaction. Returns whether there was
 * one and its image object; after the commit the erasure deletes every object
 * of the driver (`purgeDriverAvatarStorage`).
 */
export async function clearAvatarInErasure(
  tx: Tx,
  driverId: string,
): Promise<{ removed: boolean; object: StoredAvatarObject | null }> {
  const [before] = await tx
    .select(driverAvatarColumns)
    .from(drivers)
    .where(eq(drivers.id, driverId))
    .for('update');
  if (before?.avatarKind == null) return { removed: false, object: null };
  await tx
    .update(drivers)
    .set({
      avatarKind: null,
      avatarOptions: null,
      avatarS3Key: null,
      avatarS3Bucket: null,
      avatarUpdatedAt: null,
    })
    .where(eq(drivers.id, driverId));
  return { removed: true, object: storedAvatarObject(before) };
}
