// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AppError } from '@evtivity/lib';
import { getAiSettings } from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';
import { deleteObject, putObject, readObject } from '../../s3.service.js';
import type { S3Config } from '../../s3.service.js';
import {
  isAllowedAttachmentMime,
  maxPdfPagesAcrossModels,
  resolveDeclaredType,
} from './allowlist.js';
import type { AttachmentMime } from './allowlist.js';
import { processAttachment } from './process.js';
import type { ProcessedAttachment } from './process.js';

/**
 * The upload pipeline shared by AI chat and support case attachments
 * (plan 3.8): presigned POST into quarantine, then confirm reads the object,
 * sniffs and sanitizes it, writes the clean file and deletes the quarantine
 * object.
 */

export interface AttachmentLimits {
  maxBytes: number;
  maxPerMessage: number;
}

/** `ai.attachments.maxBytes` and `ai.attachments.maxPerMessage` (cached reader, P6). */
export async function attachmentLimits(): Promise<AttachmentLimits> {
  const { limits } = await getAiSettings();
  return { maxBytes: limits.attachmentsMaxBytes, maxPerMessage: limits.attachmentsMaxPerMessage };
}

export function attachmentTypeNotAllowed(contentType: string): AppError {
  return new AppError(
    `The file type ${contentType || '(none)'} is not allowed`,
    400,
    'AI_ATTACHMENT_TYPE_NOT_ALLOWED',
  );
}

export function attachmentTooLarge(detail: string): AppError {
  return new AppError(`The attachment is too large: ${detail}`, 400, 'AI_ATTACHMENT_TOO_LARGE');
}

export function attachmentRejected(detail: string): AppError {
  return new AppError(`The attachment was rejected: ${detail}`, 400, 'AI_ATTACHMENT_REJECTED');
}

/**
 * Check an upload request before a URL is issued: an allowlisted type and a
 * declared size within the limit. Throws 400 `AI_ATTACHMENT_TYPE_NOT_ALLOWED`
 * or `AI_ATTACHMENT_TOO_LARGE`.
 */
export function checkUploadRequest(
  fileName: string,
  contentType: string,
  fileSize: number,
  maxBytes: number,
): AttachmentMime {
  const declared = resolveDeclaredType(fileName, contentType);
  if (declared == null) throw attachmentTypeNotAllowed(contentType);
  if (fileSize > maxBytes) {
    throw attachmentTooLarge(`${String(fileSize)} bytes, the limit is ${String(maxBytes)}`);
  }
  return declared;
}

export interface FinalizeInput {
  s3: S3Config;
  quarantineKey: string;
  cleanKey: string;
  /**
   * The type the upload URL was issued for. Omitted for support uploads,
   * whose request is not stored: the type the POST policy pinned on the
   * object is used, and it must be allowlisted.
   */
  declaredType?: AttachmentMime;
  maxBytes: number;
}

/**
 * Check and sanitize a quarantined upload and store the clean file at
 * `cleanKey`. The quarantine object is deleted on success and on refusal
 * (fail-open: the 1-day lifecycle rule removes one a failed delete leaves).
 * Throws `AI_ATTACHMENT_REJECTED` (nothing uploaded, type mismatch, content
 * check failed) or `AI_ATTACHMENT_TOO_LARGE`.
 */
export async function finalizeUpload(
  input: FinalizeInput,
  log: FastifyBaseLogger,
): Promise<ProcessedAttachment> {
  const { s3, quarantineKey, cleanKey, maxBytes } = input;

  const removeQuarantine = async (): Promise<void> => {
    try {
      await deleteObject(s3, s3.bucket, quarantineKey);
    } catch (err) {
      log.warn(
        { err, quarantineKey },
        'attachment quarantine delete failed; the lifecycle rule expires it',
      );
    }
  };

  const read = await readObject(s3, s3.bucket, quarantineKey, maxBytes);
  if (read.status === 'missing') throw attachmentRejected('no uploaded file was found');
  if (read.status === 'too_large') {
    await removeQuarantine();
    throw attachmentTooLarge(`${String(read.size)} bytes, the limit is ${String(maxBytes)}`);
  }
  // The POST policy pins Content-Type; a different stored type means the
  // object did not come through the issued form.
  const storedType = read.contentType ?? '';
  const declaredType =
    input.declaredType ?? (isAllowedAttachmentMime(storedType) ? storedType : null);
  if (declaredType == null || storedType !== declaredType) {
    await removeQuarantine();
    throw attachmentRejected('the stored type does not match the upload request');
  }

  const result = await processAttachment(read.bytes, declaredType, {
    maxPdfPages: maxPdfPagesAcrossModels(),
  });
  if (!result.ok) {
    await removeQuarantine();
    log.info({ quarantineKey, reason: result.reason }, 'attachment refused');
    if (result.code === 'AI_ATTACHMENT_TOO_LARGE') throw attachmentTooLarge(result.reason);
    throw attachmentRejected(result.reason);
  }

  await putObject(s3, s3.bucket, cleanKey, result.bytes, result.contentType);
  await removeQuarantine();
  return result;
}

/**
 * The file name to show for a sanitized attachment: a re-encoded image gets
 * the extension of its new type.
 */
export function displayFileName(fileName: string, contentType: AttachmentMime): string {
  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : null;
  if (ext == null) return fileName;
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${base}.${ext}`;
}
