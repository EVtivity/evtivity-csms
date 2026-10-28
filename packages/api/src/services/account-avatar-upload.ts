// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  driverAvatarCleanPrefix,
  driverAvatarQuarantinePrefix,
  userAvatarCleanPrefix,
  userAvatarQuarantinePrefix,
} from '@evtivity/lib/avatar-cleanup';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '@evtivity/lib/account-avatar';
import type { AvatarMime } from '@evtivity/lib/account-avatar';
import type { ObjectStorage } from './storage.service.js';
import { finalizeUpload } from './ai/attachments/upload-flow.js';

/**
 * Avatar uploads (drivers and CSMS users) go through the attachment pipeline,
 * like station images: a presigned POST into quarantine whose policy S3
 * enforces (this key, this type, 1 byte to `AVATAR_MAX_BYTES`), then confirm
 * reads the object, sniffs the bytes against the declared type and re-encodes
 * the image to a centered square of at most 512 px (metadata dropped, JPEG or
 * PNG) under the account's clean prefix. Raster types only: an SVG can carry
 * script, and a GIF is not offered.
 */

export { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES };
export type { AvatarMime };

/** Longest side of a stored avatar image. */
export const AVATAR_EDGE_PX = 512;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** The account an avatar upload is for. */
export type AvatarUploadTarget =
  | { kind: 'driver'; driverId: string }
  | { kind: 'user'; userId: string };

/**
 * Who asks for an upload: the account itself (`self`), or an operator who
 * edits another account's avatar. `principal` names the operator request
 * (`user:<id>` for a session, `api_key:<id>` for an API key), so a key is
 * confirmed only by the principal it was issued to.
 */
export type AvatarUploader = { kind: 'self' } | { kind: 'operator'; principal: string };

const SELF: AvatarUploader = { kind: 'self' };

/**
 * Quarantine prefix of one uploader's uploads for one account, always under
 * the account's quarantine prefix (the purges and the 1-day lifecycle rule
 * cover it): the account's own uploads directly under it, an operator's under
 * `op/<hash of the principal>/`. The own key pattern never matches an
 * operator key, and one operator's never matches another's.
 */
function quarantinePrefix(target: AvatarUploadTarget, uploader: AvatarUploader): string {
  const base =
    target.kind === 'driver'
      ? driverAvatarQuarantinePrefix(target.driverId)
      : userAvatarQuarantinePrefix(target.userId);
  if (uploader.kind === 'self') return base;
  const tag = crypto.createHash('sha256').update(uploader.principal).digest('hex').slice(0, 32);
  return `${base}op/${tag}/`;
}

function cleanPrefix(target: AvatarUploadTarget): string {
  return target.kind === 'driver'
    ? driverAvatarCleanPrefix(target.driverId)
    : userAvatarCleanPrefix(target.userId);
}

export interface AvatarUploadTicket {
  /** Form POST target. */
  uploadUrl: string;
  /** Form fields to send before the `file` field, unchanged. */
  fields: Record<string, string>;
  /** The quarantine key to name at confirm. */
  s3Key: string;
  s3Bucket: string;
}

/**
 * Presigned POST into the uploader's quarantine prefix of the target. The
 * policy allows 1 to `AVATAR_MAX_BYTES` bytes of the declared type; the file
 * name is not part of the key.
 */
export async function requestAvatarUpload(
  storage: ObjectStorage,
  target: AvatarUploadTarget,
  contentType: AvatarMime,
  uploader: AvatarUploader = SELF,
): Promise<AvatarUploadTicket> {
  const key = `${quarantinePrefix(target, uploader)}${crypto.randomUUID()}/avatar`;
  const post = await storage.createUpload(key, contentType, AVATAR_MAX_BYTES);
  return { uploadUrl: post.url, fields: post.fields, s3Key: key, s3Bucket: storage.bucket };
}

/**
 * The file id of a quarantine key issued for this target to this uploader, or
 * null for any other key (another account, another uploader, outside
 * quarantine, an altered key).
 */
export function parseAvatarQuarantineKey(
  target: AvatarUploadTarget,
  s3Key: string,
  uploader: AvatarUploader = SELF,
): string | null {
  const prefix = escapeRegExp(quarantinePrefix(target, uploader));
  const match = new RegExp(`^${prefix}(${UUID})/avatar$`).exec(s3Key);
  return match?.[1] ?? null;
}

/** The clean key prefix of one upload: confirm stores it as `<prefix>jpg` or `<prefix>png`. */
export function avatarCleanKeyPrefix(target: AvatarUploadTarget, fileId: string): string {
  return `${cleanPrefix(target)}${fileId}.`;
}

export interface FinalizedAvatar {
  s3Key: string;
  contentType: 'image/jpeg' | 'image/png';
}

/**
 * Check, crop and re-encode a quarantined avatar and store it under the
 * account's clean prefix. Throws 400 `AI_ATTACHMENT_REJECTED` (nothing
 * uploaded, another stored type, bytes of another type, an image that does
 * not decode) or `AI_ATTACHMENT_TOO_LARGE` (1 MB or more, too many pixels),
 * and deletes the quarantine object either way.
 */
export async function finalizeAvatar(
  storage: ObjectStorage,
  target: AvatarUploadTarget,
  quarantineKey: string,
  fileId: string,
  log: FastifyBaseLogger,
): Promise<FinalizedAvatar> {
  // The output type is known only after the re-encode, so the bytes are
  // written under a key that names it: JPEG unless the image has alpha.
  const prefix = avatarCleanKeyPrefix(target, fileId);
  const keyFor = (contentType: string): string =>
    `${prefix}${contentType === 'image/png' ? 'png' : 'jpg'}`;
  const processed = await finalizeUpload(
    {
      storage,
      quarantineKey,
      cleanKey: keyFor,
      acceptTypes: AVATAR_MIME_TYPES,
      maxBytes: AVATAR_MAX_BYTES,
      image: { maxEdgePx: AVATAR_EDGE_PX, square: true },
    },
    log,
  );
  return {
    s3Key: keyFor(processed.contentType),
    contentType: processed.contentType === 'image/png' ? 'image/png' : 'image/jpeg',
  };
}
