// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db, supportCaseAttachments } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import {
  buildS3Key,
  buildSupportQuarantineKey,
  generateDownloadUrl,
  generateUploadPost,
  getS3Config,
  QUARANTINE_PREFIX,
  UPLOAD_URL_EXPIRES_SECONDS,
} from '../../s3.service.js';
import type { S3Config } from '../../s3.service.js';
import { isAllowedAttachmentMime } from './allowlist.js';
import {
  attachmentLimits,
  checkUploadRequest,
  displayFileName,
  finalizeUpload,
} from './upload-flow.js';

/**
 * Support case attachments (operator and portal routes). The routes check
 * case access (site scope or driver ownership) before calling these; these
 * functions only handle the upload pipeline and the attachment row.
 */

function storageNotConfigured(): AppError {
  return new AppError('S3 not configured', 400, 'STORAGE_NOT_CONFIGURED');
}

async function requireS3(): Promise<S3Config> {
  const s3 = await getS3Config();
  if (s3 == null) throw storageNotConfigured();
  return s3;
}

export interface SupportUploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  s3Key: string;
  expiresAt: Date;
}

/**
 * Presigned POST into quarantine for a message attachment. 400
 * `AI_ATTACHMENT_TYPE_NOT_ALLOWED`, `AI_ATTACHMENT_TOO_LARGE` or
 * `STORAGE_NOT_CONFIGURED`.
 */
export async function requestSupportAttachmentUpload(
  caseId: string,
  messageId: number,
  request: { fileName: string; contentType: string; fileSize: number },
): Promise<SupportUploadTicket> {
  const { maxBytes } = await attachmentLimits();
  const declaredType = checkUploadRequest(
    request.fileName,
    request.contentType,
    request.fileSize,
    maxBytes,
  );
  const s3 = await requireS3();
  const key = buildSupportQuarantineKey(caseId, messageId, crypto.randomUUID(), request.fileName);
  const post = await generateUploadPost(s3, key, declaredType, maxBytes);
  return {
    uploadUrl: post.url,
    fields: post.fields,
    s3Key: key,
    expiresAt: new Date(Date.now() + UPLOAD_URL_EXPIRES_SECONDS * 1000),
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Parse a quarantine key issued for this case and message. Anything else
 * (another case or message, a path outside quarantine, an altered name) is
 * refused with 400 `VALIDATION_ERROR`, so a client cannot register an object
 * it did not upload through this message's form.
 */
function parseQuarantineKey(
  caseId: string,
  messageId: number,
  s3Key: string,
): { fileId: string; fileName: string } {
  const prefix = `${QUARANTINE_PREFIX}support-cases/${caseId}/${String(messageId)}/`;
  const rest = s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : '';
  const match = new RegExp(`^(${UUID})/([A-Za-z0-9_-][A-Za-z0-9._-]{0,99})$`).exec(rest);
  if (match?.[1] == null || match[2] == null) {
    throw new AppError(
      'Attachment metadata does not match issued upload URL',
      400,
      'VALIDATION_ERROR',
    );
  }
  return { fileId: match[1], fileName: match[2] };
}

export type SupportAttachmentRow = typeof supportCaseAttachments.$inferSelect;

/**
 * Check, sanitize and store an uploaded attachment, then record it on the
 * message. Idempotent: a second confirm of the same key returns the row the
 * first one stored. Throws 400 `VALIDATION_ERROR`, `AI_ATTACHMENT_REJECTED`,
 * `AI_ATTACHMENT_TOO_LARGE` or `STORAGE_NOT_CONFIGURED`.
 */
export async function confirmSupportAttachment(
  caseId: string,
  messageId: number,
  s3Key: string,
  log: FastifyBaseLogger,
): Promise<{ attachment: SupportAttachmentRow; created: boolean }> {
  const { fileId, fileName } = parseQuarantineKey(caseId, messageId, s3Key);
  const cleanKey = buildS3Key(caseId, messageId, fileId, fileName);

  const [existing] = await db
    .select()
    .from(supportCaseAttachments)
    .where(
      and(
        eq(supportCaseAttachments.messageId, messageId),
        eq(supportCaseAttachments.s3Key, cleanKey),
      ),
    );
  if (existing != null) return { attachment: existing, created: false };

  const s3 = await requireS3();
  const { maxBytes } = await attachmentLimits();
  const processed = await finalizeUpload({ s3, quarantineKey: s3Key, cleanKey, maxBytes }, log);

  const [attachment] = await db
    .insert(supportCaseAttachments)
    .values({
      messageId,
      fileName: displayFileName(fileName, processed.contentType),
      fileSize: processed.bytes.length,
      contentType: processed.contentType,
      s3Key: cleanKey,
      s3Bucket: s3.bucket,
    })
    .returning();
  if (attachment == null) throw new Error('support attachment insert returned no row');
  return { attachment, created: true };
}

/**
 * Presigned download served as an attachment. A row stored before the
 * upload pipeline carries a client-declared type: unless it is allowlisted it
 * is served as `application/octet-stream`.
 */
export async function supportAttachmentDownloadUrl(attachment: {
  s3Bucket: string;
  s3Key: string;
  fileName: string;
  contentType: string;
}): Promise<string> {
  const s3 = await requireS3();
  const contentType = isAllowedAttachmentMime(attachment.contentType)
    ? attachment.contentType
    : 'application/octet-stream';
  return generateDownloadUrl(s3, attachment.s3Bucket, attachment.s3Key, {
    fileName: attachment.fileName,
    contentType,
  });
}
