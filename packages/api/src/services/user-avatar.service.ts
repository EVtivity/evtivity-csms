// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users, userAuditLog, writeAudit } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { generatedAvatarProblem } from '@evtivity/lib/account-avatar';
import type { GeneratedAvatar } from '@evtivity/lib/account-avatar';
import {
  enqueueUserAvatarObjectDelete,
  enqueueUserAvatarPurge,
} from '@evtivity/lib/avatar-cleanup';
import { purgeUserAvatarObjects } from '@evtivity/services/avatar-storage';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { deleteObject } from './s3.service.js';
import type { S3Config } from './s3.service.js';
import {
  avatarChanged,
  avatarRowOf,
  getS3ConfigOrNull,
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
 * The only writer of `users.avatar_*` (P3), the CSMS user (operator) avatar.
 * Same rules as the driver avatar: a generated avatar (DiceBear options) or an
 * uploaded image (a clean S3 object), one at a time. The user sets its own
 * (`/v1/users/me/avatar`, the Profile page), an operator with `users:write`
 * another user's (`/v1/users/:id/avatar`, audited in the operator's name);
 * the user delete clears it.
 * The row is written first, then the replaced image is deleted (P4); a
 * failed delete is queued on the `driver-avatar-cleanup` worker queue.
 */

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

export interface UserAvatarContext {
  actor: AuditActorInfo;
  log: Logger;
  /** Audit note. */
  note: string;
}

export interface UserAvatarWriteResult {
  avatar: AvatarRow;
  changed: boolean;
}

/** The avatar columns a user read selects and `avatarView` turns into the reply. */
export const userAvatarColumns = {
  avatarKind: users.avatarKind,
  avatarOptions: users.avatarOptions,
  avatarS3Key: users.avatarS3Key,
  avatarS3Bucket: users.avatarS3Bucket,
  avatarUpdatedAt: users.avatarUpdatedAt,
};

function userNotFound(): AppError {
  return new AppError('User not found', 404, 'USER_NOT_FOUND');
}

/**
 * Deletes a user avatar object no row points at any more; queued for the
 * worker when storage is not configured or the delete fails (fail-open, P9).
 */
async function deleteUserAvatarObject(
  userId: string,
  object: StoredAvatarObject | null,
  log: Logger,
): Promise<void> {
  if (object == null) return;
  const s3 = await getS3ConfigOrNull();
  if (s3 != null) {
    try {
      await deleteObject(s3, object.bucket, object.key);
      return;
    } catch (err) {
      log.warn({ err, key: object.key }, 'user avatar object delete failed, queued');
    }
  } else {
    log.warn({ key: object.key }, 'user avatar object delete queued: S3 is not configured');
  }
  try {
    await enqueueUserAvatarObjectDelete({ userId, bucket: object.bucket, key: object.key });
  } catch (err) {
    log.warn({ err, key: object.key }, 'user avatar object delete could not be queued');
  }
}

/**
 * Locks the user row, writes the avatar, returns the previous and the new
 * columns. A write that changes nothing leaves the row as it is.
 */
async function writeAvatar(
  userId: string,
  next: AvatarValues,
): Promise<{ before: AvatarRow; after: AvatarRow }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select(userAvatarColumns)
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (locked == null) throw userNotFound();
    const before = avatarRowOf(locked);
    if (!avatarChanged(before, next)) return { before, after: before };
    const [after] = await tx
      .update(users)
      .set({ ...next, avatarUpdatedAt: next.avatarKind == null ? null : new Date() })
      .where(eq(users.id, userId))
      .returning(userAvatarColumns);
    if (after == null) throw userNotFound();
    return { before, after };
  });
}

/** After the commit: delete the replaced image and audit the change (kinds only). */
async function afterWrite(
  userId: string,
  result: { before: AvatarRow; after: AvatarRow },
  ctx: UserAvatarContext,
): Promise<boolean> {
  if (!avatarChanged(result.before, result.after)) return false;
  const previous = storedAvatarObject(result.before);
  if (previous != null && previous.key !== result.after.avatarS3Key) {
    await deleteUserAvatarObject(userId, previous, ctx.log);
  }
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: userId,
      entityIdSnapshot: userId,
      action: 'updated',
      ...ctx.actor,
      before: { avatar: result.before.avatarKind },
      after: { avatar: result.after.avatarKind },
      notes: ctx.note,
    },
    db,
    ctx.log,
  );
  return true;
}

/** The avatar columns of a user: 404 `USER_NOT_FOUND` for an unknown one. */
export async function userAvatarRow(userId: string): Promise<AvatarRow> {
  const [row] = await db.select(userAvatarColumns).from(users).where(eq(users.id, userId));
  if (row == null) throw userNotFound();
  return avatarRowOf(row);
}

/**
 * Sets a generated avatar. Throws 400 `VALIDATION_ERROR` when it is not on the
 * allow-list. The same avatar again changes nothing (no write, no audit).
 */
export async function setUserGeneratedAvatar(
  userId: string,
  avatar: unknown,
  ctx: UserAvatarContext,
): Promise<UserAvatarWriteResult> {
  const problem = generatedAvatarProblem(avatar);
  if (problem != null) throw new AppError(problem, 400, 'VALIDATION_ERROR');
  const valid = avatar as GeneratedAvatar;
  const result = await writeAvatar(userId, {
    avatarKind: 'generated',
    avatarOptions: { style: valid.style, seed: valid.seed, options: valid.options },
    avatarS3Key: null,
    avatarS3Bucket: null,
  });
  return { avatar: result.after, changed: await afterWrite(userId, result, ctx) };
}

/**
 * Confirms an uploaded avatar: the quarantine key must be one issued for this
 * user to this uploader (the user, or the operator principal in
 * `ctx.uploader`) and the bucket the configured one (else 400
 * `VALIDATION_ERROR`, nothing read from S3). A retry of a confirmed key
 * returns the current avatar.
 */
export async function confirmUserUploadedAvatar(
  userId: string,
  s3: S3Config,
  upload: { s3Key: string; s3Bucket: string },
  ctx: UserAvatarContext & { log: FastifyBaseLogger; uploader?: AvatarUploader },
): Promise<AvatarRow> {
  const target = { kind: 'user', userId } as const;
  const fileId = parseAvatarQuarantineKey(target, upload.s3Key, ctx.uploader);
  if (fileId == null || upload.s3Bucket !== s3.bucket) {
    throw new AppError(
      'The image key or bucket does not belong to this user',
      400,
      'VALIDATION_ERROR',
    );
  }
  const current = await userAvatarRow(userId);
  if (current.avatarS3Key?.startsWith(avatarCleanKeyPrefix(target, fileId)) === true) {
    return current;
  }

  const stored = await finalizeAvatar(s3, target, upload.s3Key, fileId, ctx.log);
  let result;
  try {
    result = await writeAvatar(userId, {
      avatarKind: 'image',
      avatarOptions: null,
      avatarS3Key: stored.s3Key,
      avatarS3Bucket: s3.bucket,
    });
  } catch (err) {
    await deleteUserAvatarObject(userId, { key: stored.s3Key, bucket: s3.bucket }, ctx.log);
    throw err;
  }
  await afterWrite(userId, result, ctx);
  return result.after;
}

/** Removes the avatar (initials are shown). Idempotent. Returns whether there was one. */
export async function removeUserAvatar(userId: string, ctx: UserAvatarContext): Promise<boolean> {
  const result = await writeAvatar(userId, {
    avatarKind: null,
    avatarOptions: null,
    avatarS3Key: null,
    avatarS3Bucket: null,
  });
  return afterWrite(userId, result, ctx);
}

/**
 * Deletes every stored object of a deleted (deactivated) user: clears the
 * avatar, then deletes everything under the user's prefixes (images earlier
 * failed deletes left, unconfirmed uploads). A storage failure, or storage not
 * configured while the row named an image, queues the purge for the worker
 * (fail-open, logged), which runs it only while the user stays inactive
 * without an avatar. Never throws: the user is already deactivated (P9).
 */
export async function purgeUserAvatarOnDelete(
  userId: string,
  ctx: UserAvatarContext,
): Promise<void> {
  // The deactivation already happened: a failed clear is logged and the purge still runs
  // (the worker purges only a user without an avatar, so a failed clear keeps its image).
  let rowBucket: string | null = null;
  try {
    rowBucket = (await userAvatarRow(userId)).avatarS3Bucket;
    await removeUserAvatar(userId, ctx);
  } catch (err) {
    ctx.log.warn({ err, userId }, 'user avatar not cleared with the user');
  }
  const buckets = rowBucket != null ? [rowBucket] : [];
  const s3 = await getS3ConfigOrNull();
  if (s3 == null && buckets.length === 0) return;
  if (s3 != null) {
    try {
      await purgeUserAvatarObjects(s3, userId, buckets);
      return;
    } catch (err) {
      ctx.log.warn({ err, userId }, 'user avatar purge failed, queued');
    }
  } else {
    ctx.log.warn({ userId }, 'user avatar purge queued: S3 is not configured');
  }
  try {
    await enqueueUserAvatarPurge({ userId, buckets });
  } catch (err) {
    ctx.log.warn({ err, userId }, 'user avatar purge could not be queued');
  }
}
