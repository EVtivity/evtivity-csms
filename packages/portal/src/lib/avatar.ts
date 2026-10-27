// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import type { AvatarUploadTicket } from '@evtivity/lib/account-avatar';
import { api } from './api';

/** The driver avatar as the API returns it (GET /v1/portal/driver/avatar). */
export type DriverAvatar =
  | {
      kind: 'generated';
      style: 'avataaars';
      seed: string;
      options: Record<string, string | number>;
      updatedAt: string | null;
    }
  | { kind: 'image'; url: string | null; expiresAt: string | null; updatedAt: string | null };

export const AVATAR_QUERY_KEY = ['portal-driver-avatar'] as const;

/** The signed-in driver's avatar. The image URL is valid for an hour, so it is fetched again after 30 minutes. */
export function useDriverAvatar(enabled = true) {
  return useQuery({
    queryKey: AVATAR_QUERY_KEY,
    queryFn: async () =>
      (await api.get<{ avatar: DriverAvatar | null }>('/v1/portal/driver/avatar')).avatar,
    staleTime: 30 * 60_000,
    enabled,
  });
}

/**
 * Uploads an avatar image: an upload URL, the browser POST of the policy fields
 * and the file to S3 (`postAvatarUpload`, shared with the CSMS), then the
 * confirm that crops and stores it. The caller checks the file first
 * (`avatarFileProblem` of `@evtivity/lib/account-avatar`).
 */
export async function uploadAvatarImage(file: File): Promise<DriverAvatar | null> {
  const { postAvatarUpload } = await import('@evtivity/lib/account-avatar');
  const ticket = await api.post<AvatarUploadTicket>('/v1/portal/driver/avatar/upload-url', {
    fileName: file.name,
    contentType: file.type,
    fileSize: file.size,
  });
  // S3 enforces the presigned POST policy: this key, this type, smaller than 1 MB.
  await postAvatarUpload(ticket, file);
  const confirmed = await api.post<{ avatar: DriverAvatar | null }>(
    '/v1/portal/driver/avatar/image',
    { s3Key: ticket.s3Key, s3Bucket: ticket.s3Bucket },
  );
  return confirmed.avatar;
}

/** Up to two initials of a name, for a driver without an avatar. */
export function initialsOf(firstName: string | null | undefined, lastName?: string | null): string {
  const letters = [firstName, lastName]
    .map((part) => (part ?? '').trim().charAt(0))
    .filter((c) => c !== '')
    .join('');
  return letters.toUpperCase();
}
