// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import type { UploadTarget } from '@evtivity/services/storage';

/**
 * How a client uploads a file, shared by every upload-url response. AWS S3
 * and S3-compatible providers take a form POST; Cloudflare R2 takes a PUT
 * signed for exactly the declared size.
 */
export const uploadTargetResponseFields = {
  uploadUrl: z
    .string()
    .describe(
      'Presigned upload URL. With uploadMethod POST, send a multipart/form-data POST with every entry of fields, then the file as the last field named file. With PUT, send the file as the request body with uploadHeaders. The storage provider enforces the size and the Content-Type.',
    ),
  uploadMethod: z
    .enum(['POST', 'PUT'])
    .describe(
      'POST (a form upload: AWS S3 and S3-compatible providers) or PUT (Cloudflare R2, signed for exactly the declared size)',
    ),
  fields: z
    .record(z.string(), z.string())
    .describe('Form fields to send unchanged before the file field (POST); empty for PUT'),
  uploadHeaders: z
    .record(z.string(), z.string())
    .describe(
      'Headers to send unchanged with the PUT; empty for POST. The body must be exactly the declared file size',
    ),
};

/** The upload-url response fields of one upload target. */
export function uploadTargetResponse(target: UploadTarget): {
  uploadUrl: string;
  uploadMethod: 'POST' | 'PUT';
  fields: Record<string, string>;
  uploadHeaders: Record<string, string>;
} {
  return target.method === 'POST'
    ? { uploadUrl: target.url, uploadMethod: 'POST', fields: target.fields, uploadHeaders: {} }
    : { uploadUrl: target.url, uploadMethod: 'PUT', fields: {}, uploadHeaders: target.headers };
}
