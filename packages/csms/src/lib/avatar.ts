// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AvatarUploadTicket, GeneratedAvatar } from '@evtivity/lib/account-avatar';
import type { AvatarData } from '@/components/AccountAvatar';
import { api } from '@/lib/api';

/**
 * What the avatar editor hands back: a generated avatar, a picked image file,
 * or the removal of the current avatar. Stored with `applyAvatarChoice`: the
 * own avatar on the Profile page, another user's (users:write) and a driver's
 * (drivers:write) in their edit forms and New pages.
 */
export type AvatarChoice =
  | { kind: 'generated'; avatar: GeneratedAvatar }
  | { kind: 'image'; file: File }
  | { kind: 'remove' };

/** The avatar routes of the signed-in user. */
export const OWN_AVATAR_PATH = '/v1/users/me/avatar';

/** The avatar routes of a driver (drivers:write). */
export function driverAvatarPath(driverId: string): string {
  return `/v1/drivers/${encodeURIComponent(driverId)}/avatar`;
}

/**
 * The avatar routes of a CSMS user: the own routes for the signed-in user
 * (the API refuses the own id on `/v1/users/:id/avatar`), else the users:write
 * routes.
 */
export function userAvatarPath(userId: string, ownUserId: string | null | undefined): string {
  return userId === ownUserId ? OWN_AVATAR_PATH : `/v1/users/${encodeURIComponent(userId)}/avatar`;
}

/** The preview of an avatar choice not stored yet (New pages); `imageUrl` is the picked file's object URL. */
export function pendingAvatarPreview(
  choice: AvatarChoice | null,
  imageUrl: string | null,
): AvatarData | null {
  if (choice == null || choice.kind === 'remove') return null;
  if (choice.kind === 'image') return { kind: 'image', url: imageUrl };
  const { style, seed, options } = choice.avatar;
  return { kind: 'generated', style, seed, options };
}

/**
 * Stores an avatar choice through the avatar routes at `basePath`: PUT for a
 * generated avatar, the upload URL, the storage POST and the confirm for an
 * image, DELETE for a removal. Returns the stored avatar (null after a
 * removal). The caller checks an image file first (`avatarFileProblem`).
 */
export async function applyAvatarChoice(
  basePath: string,
  choice: AvatarChoice,
): Promise<AvatarData | null> {
  if (choice.kind === 'remove') {
    await api.delete(basePath);
    return null;
  }
  if (choice.kind === 'generated') {
    const { style, seed, options } = choice.avatar;
    const res = await api.put<{ avatar: AvatarData | null }>(basePath, { style, seed, options });
    return res.avatar;
  }
  const { file } = choice;
  const ticket = await api.post<AvatarUploadTicket>(`${basePath}/upload-url`, {
    fileName: file.name,
    contentType: file.type,
    fileSize: file.size,
  });
  // S3 enforces the presigned POST policy: this key, this type, smaller than 1 MB.
  const { postAvatarUpload } = await import('@evtivity/lib/account-avatar');
  await postAvatarUpload(ticket, file);
  const res = await api.post<{ avatar: AvatarData | null }>(`${basePath}/image`, {
    s3Key: ticket.s3Key,
    s3Bucket: ticket.s3Bucket,
  });
  return res.avatar;
}
