// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { AVATAR_OPTIONS_MAX_JSON, AVATAR_MIME_TYPES } from '@evtivity/lib/account-avatar';

/** The avatar of a driver or CSMS user in replies (`avatarView`). */
export const avatarItem = z
  .object({
    kind: z
      .enum(['generated', 'image'])
      .describe('generated: a DiceBear Avataaars avatar; image: an uploaded picture'),
    style: z.literal('avataaars').optional().describe('With kind generated: the DiceBear style'),
    seed: z.string().max(64).optional().describe('With kind generated: the DiceBear seed'),
    options: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe(
        'With kind generated: the DiceBear options (component variants, colors as six hex digits without #, 0 or 100 probabilities, flip). Render with @dicebear/core and @dicebear/styles avataaars',
      ),
    url: z
      .string()
      .nullable()
      .optional()
      .describe(
        'With kind image: a presigned URL of the square JPEG or PNG (valid 1 hour), or null when file storage is no longer configured (show initials)',
      ),
    expiresAt: z.string().nullable().optional().describe('With kind image: when url stops working'),
    updatedAt: z.string().nullable().describe('When the avatar last changed'),
  })
  .loose()
  .nullable()
  .describe(
    'The avatar, or null (show initials). Every driver and CSMS user sets its own; operators with drivers:write or users:write set others',
  );

/** `{ avatar }`: the reply of every avatar read and write. */
export const avatarReply = z.object({ avatar: avatarItem }).loose();

/** Body of the avatar PUT routes: a generated avatar (the service checks the values). */
export const generatedAvatarBody = z.object({
  style: z.literal('avataaars').describe('The DiceBear style'),
  seed: z.string().min(1).max(64).describe('Letters, digits, hyphens or underscores'),
  // Values are checked by the service, not coerced here: a color of six digits
  // must stay a string and a probability a number.
  options: z
    .record(z.string(), z.unknown())
    .describe(
      `DiceBear Avataaars options from the allow-list (component variants, palette colors as six lowercase hex digits without #, 0 or 100 probabilities, flip none or horizontal). At most ${String(AVATAR_OPTIONS_MAX_JSON)} characters of JSON`,
    ),
});

/** Body of the avatar upload-url routes. */
export const avatarUploadUrlBody = z.object({
  fileName: z.string().min(1).max(255).describe('Shown only; not part of the stored key'),
  contentType: z
    .enum(AVATAR_MIME_TYPES)
    .describe('MIME type of the file (image/jpeg, image/png or image/webp)'),
  fileSize: z
    .number()
    .int()
    .min(1)
    .describe('File size in bytes: smaller than 1 MB (at most 1,048,575 bytes)'),
});

export const avatarUploadUrlResponse = z
  .object({
    uploadUrl: z
      .string()
      .describe('Presigned S3 POST URL the client sends the form to (the file field last)'),
    fields: z
      .record(z.string(), z.string())
      .describe('Form fields to send unchanged before the file field (the POST policy)'),
    s3Key: z.string().describe('Quarantine key of the upload, sent back at confirm'),
    s3Bucket: z.string().describe('S3 bucket the file is uploaded to'),
  })
  .loose();

/** Body of the avatar confirm routes. */
export const avatarConfirmBody = z.object({
  s3Key: z.string().min(1).max(1024).describe('The quarantine key from upload-url'),
  s3Bucket: z.string().min(1).max(255).describe('The bucket from upload-url'),
});
