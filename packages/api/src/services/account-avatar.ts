// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { GeneratedAvatar } from '@evtivity/lib/account-avatar';
import { generateDownloadUrl, getS3Config } from './s3.service.js';
import type { S3Config } from './s3.service.js';

/**
 * The avatar reads and comparisons shared by the driver avatar service (the
 * only writer of `drivers.avatar_*`) and the user avatar service (the only
 * writer of `users.avatar_*`). Nothing here writes a row.
 */

/** The avatar columns of a driver or user row. */
export interface AvatarRow {
  avatarKind: string | null;
  avatarOptions: unknown;
  avatarS3Key: string | null;
  avatarS3Bucket: string | null;
  avatarUpdatedAt: Date | null;
}

/** The avatar as clients receive it. */
export type AvatarView =
  | ({ kind: 'generated'; updatedAt: string | null } & GeneratedAvatar)
  | { kind: 'image'; url: string | null; expiresAt: string | null; updatedAt: string | null };

/** The values a write stores. */
export interface AvatarValues {
  avatarKind: 'generated' | 'image' | null;
  avatarOptions: GeneratedAvatar | null;
  avatarS3Key: string | null;
  avatarS3Bucket: string | null;
}

export interface StoredAvatarObject {
  key: string;
  bucket: string;
}

/** Lifetime of an avatar image URL (the presigned GET). */
const AVATAR_URL_SECONDS = 3600;

/** `Cache-Control` of an avatar image response (the presigned GET). */
export const AVATAR_CACHE_CONTROL = 'private, no-store';

function avatarContentType(key: string): 'image/png' | 'image/jpeg' {
  return key.endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/**
 * The avatar of a row as clients receive it: null (no avatar, show initials),
 * the generated options, or a presigned image URL (1 hour, inline with the
 * raster type the pipeline stored). `url` is null when S3 is no longer
 * configured, so clients fall back to initials.
 */
export async function avatarView(row: AvatarRow, s3: S3Config | null): Promise<AvatarView | null> {
  const updatedAt = row.avatarUpdatedAt?.toISOString() ?? null;
  if (row.avatarKind === 'generated' && row.avatarOptions != null) {
    return { kind: 'generated', updatedAt, ...(row.avatarOptions as GeneratedAvatar) };
  }
  if (row.avatarKind === 'image' && row.avatarS3Key != null && row.avatarS3Bucket != null) {
    if (s3 == null) return { kind: 'image', url: null, expiresAt: null, updatedAt };
    const contentType = avatarContentType(row.avatarS3Key);
    const url = await generateDownloadUrl(s3, row.avatarS3Bucket, row.avatarS3Key, {
      fileName: contentType === 'image/png' ? 'avatar.png' : 'avatar.jpg',
      contentType,
      disposition: 'inline',
      // A removed or replaced photo must not stay in a browser or proxy cache.
      cacheControl: AVATAR_CACHE_CONTROL,
    });
    return {
      kind: 'image',
      url,
      expiresAt: new Date(Date.now() + AVATAR_URL_SECONDS * 1000).toISOString(),
      updatedAt,
    };
  }
  return null;
}

/** The S3 config, or null when it is not configured or cannot be read. */
export async function getS3ConfigOrNull(): Promise<S3Config | null> {
  try {
    return await getS3Config();
  } catch {
    // fail-open: an unreadable S3 setting shows initials instead of failing the read
    return null;
  }
}

/** `avatarView` for many rows with one S3 config read; each row gets `avatar`, its raw columns removed. */
export async function withAvatars<T extends AvatarRow>(
  rows: T[],
): Promise<Array<Omit<T, keyof AvatarRow> & { avatar: AvatarView | null }>> {
  const needsS3 = rows.some((r) => r.avatarKind === 'image');
  const s3 = needsS3 ? await getS3ConfigOrNull() : null;
  return Promise.all(
    rows.map(async (row) => {
      const { avatarKind, avatarOptions, avatarS3Key, avatarS3Bucket, avatarUpdatedAt, ...rest } =
        row;
      const avatar = await avatarView(
        { avatarKind, avatarOptions, avatarS3Key, avatarS3Bucket, avatarUpdatedAt },
        s3,
      );
      return { ...rest, avatar };
    }),
  );
}

/** The image object a row names, or null. */
export function storedAvatarObject(row: {
  avatarS3Key: string | null;
  avatarS3Bucket: string | null;
}): StoredAvatarObject | null {
  return row.avatarS3Key != null && row.avatarS3Bucket != null
    ? { key: row.avatarS3Key, bucket: row.avatarS3Bucket }
    : null;
}

/** JSON with object keys sorted, so options stored as jsonb compare equal to the same options sent. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

type AvatarColumns = Pick<
  AvatarRow,
  'avatarKind' | 'avatarOptions' | 'avatarS3Key' | 'avatarS3Bucket'
>;

/** Whether a write changes the avatar (options compared by value). */
export function avatarChanged(before: AvatarColumns, after: AvatarColumns): boolean {
  return (
    before.avatarKind !== after.avatarKind ||
    before.avatarS3Key !== after.avatarS3Key ||
    before.avatarS3Bucket !== after.avatarS3Bucket ||
    canonicalJson(before.avatarOptions) !== canonicalJson(after.avatarOptions)
  );
}

/** The columns of a row, without anything else it holds. */
export function avatarRowOf(row: AvatarRow): AvatarRow {
  return {
    avatarKind: row.avatarKind,
    avatarOptions: row.avatarOptions,
    avatarS3Key: row.avatarS3Key,
    avatarS3Bucket: row.avatarS3Bucket,
    avatarUpdatedAt: row.avatarUpdatedAt,
  };
}
