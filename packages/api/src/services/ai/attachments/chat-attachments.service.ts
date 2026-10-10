// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db, aiAttachments } from '@evtivity/database';
import type { AiAttachmentKind } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import {
  deleteObject,
  generateDownloadUrl,
  generateUploadPost,
  getS3Config,
  QUARANTINE_PREFIX,
  readObject,
  sanitizeFileName,
  UPLOAD_URL_EXPIRES_SECONDS,
} from '../../s3.service.js';
import type { S3Config } from '../../s3.service.js';
import { isAllowedAttachmentMime } from './allowlist.js';
import type { AttachmentMime } from './allowlist.js';
import {
  attachmentLimits,
  attachmentTooLarge,
  checkUploadRequest,
  displayFileName,
  finalizeUpload,
} from './upload-flow.js';

/**
 * The only writer of `ai_attachments` (P3). Chat attachments belong to the
 * user who uploaded them: every read and write is scoped to that user and
 * answers 404 `ATTACHMENT_NOT_FOUND` for anyone else (P11, no existence leak).
 */

export interface ChatAttachment {
  id: string;
  fileName: string;
  contentType: AttachmentMime;
  kind: AiAttachmentKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  pageCount: number | null;
  conversationId: string | null;
  createdAt: Date;
}

type AttachmentRow = typeof aiAttachments.$inferSelect;

function notFound(): AppError {
  return new AppError('Attachment not found', 404, 'ATTACHMENT_NOT_FOUND');
}

function storageNotConfigured(): AppError {
  return new AppError('S3 not configured', 400, 'STORAGE_NOT_CONFIGURED');
}

async function requireS3(): Promise<S3Config> {
  const s3 = await getS3Config();
  if (s3 == null) throw storageNotConfigured();
  return s3;
}

function toChatAttachment(row: AttachmentRow): ChatAttachment {
  const contentType = row.contentType ?? '';
  if (row.status !== 'ready' || row.kind == null || !isAllowedAttachmentMime(contentType)) {
    throw notFound();
  }
  return {
    id: row.id,
    fileName: row.fileName,
    contentType,
    kind: row.kind,
    sizeBytes: row.sizeBytes ?? 0,
    width: row.width,
    height: row.height,
    pageCount: row.pageCount,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}

async function loadOwned(userId: string, attachmentId: string): Promise<AttachmentRow> {
  const [row] = await db
    .select()
    .from(aiAttachments)
    .where(
      and(
        eq(aiAttachments.id, attachmentId),
        eq(aiAttachments.userId, userId),
        isNull(aiAttachments.deletedAt),
      ),
    );
  if (row == null) throw notFound();
  return row;
}

function userKeySegment(userId: string): string {
  return sanitizeFileName(userId, 'user');
}

export interface ChatUploadRequest {
  fileName: string;
  contentType: string;
  fileSize: number;
}

export interface ChatUploadTicket {
  attachmentId: string;
  uploadUrl: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

/**
 * Issue a presigned POST into quarantine and record a `pending` attachment.
 * 400 `AI_ATTACHMENT_TYPE_NOT_ALLOWED`, `AI_ATTACHMENT_TOO_LARGE` or
 * `STORAGE_NOT_CONFIGURED`.
 */
export async function requestChatAttachmentUpload(
  userId: string,
  request: ChatUploadRequest,
): Promise<ChatUploadTicket> {
  const { maxBytes } = await attachmentLimits();
  const declaredType = checkUploadRequest(
    request.fileName,
    request.contentType,
    request.fileSize,
    maxBytes,
  );
  const s3 = await requireS3();
  const id = crypto.randomUUID();
  const fileName = sanitizeFileName(request.fileName);
  const quarantineKey = `${QUARANTINE_PREFIX}chat/${userKeySegment(userId)}/${id}/${fileName}`;

  const post = await generateUploadPost(s3, quarantineKey, declaredType, maxBytes);
  await db.insert(aiAttachments).values({
    id,
    userId,
    status: 'pending',
    fileName,
    declaredType,
    declaredSize: request.fileSize,
    s3Bucket: s3.bucket,
    quarantineKey,
  });
  return {
    attachmentId: id,
    uploadUrl: post.url,
    fields: post.fields,
    expiresAt: new Date(Date.now() + UPLOAD_URL_EXPIRES_SECONDS * 1000),
  };
}

/**
 * Check and sanitize the uploaded file and mark the attachment `ready`.
 * Idempotent: confirming a ready attachment returns it again. A refused
 * upload is marked deleted (the retention cron removes the row) and throws
 * `AI_ATTACHMENT_REJECTED` or `AI_ATTACHMENT_TOO_LARGE`.
 */
export async function confirmChatAttachment(
  userId: string,
  attachmentId: string,
  log: FastifyBaseLogger,
): Promise<ChatAttachment> {
  const row = await loadOwned(userId, attachmentId);
  if (row.status === 'ready') return toChatAttachment(row);
  if (!isAllowedAttachmentMime(row.declaredType)) throw notFound();

  const s3 = await requireS3();
  if (s3.bucket !== row.s3Bucket) throw storageNotConfigured();
  const { maxBytes } = await attachmentLimits();
  const cleanKey = `ai-uploads/chat/${userKeySegment(userId)}/${row.id}-${row.fileName}`;

  let processed;
  try {
    processed = await finalizeUpload(
      { s3, quarantineKey: row.quarantineKey, cleanKey, declaredType: row.declaredType, maxBytes },
      log,
    );
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 400) {
      await db
        .update(aiAttachments)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(aiAttachments.id, row.id), eq(aiAttachments.status, 'pending')));
    }
    throw err;
  }

  const [updated] = await db
    .update(aiAttachments)
    .set({
      status: 'ready',
      fileName: displayFileName(row.fileName, processed.contentType),
      contentType: processed.contentType,
      kind: processed.kind,
      sizeBytes: processed.bytes.length,
      width: processed.width ?? null,
      height: processed.height ?? null,
      pageCount: processed.pageCount ?? null,
      s3Key: cleanKey,
      confirmedAt: sql`now()`,
    })
    .where(and(eq(aiAttachments.id, row.id), eq(aiAttachments.status, 'pending')))
    .returning();
  // A concurrent confirm finished first: return its result.
  return toChatAttachment(updated ?? (await loadOwned(userId, attachmentId)));
}

/** Metadata of a ready attachment owned by the user. */
export async function getChatAttachment(
  userId: string,
  attachmentId: string,
): Promise<ChatAttachment> {
  return toChatAttachment(await loadOwned(userId, attachmentId));
}

/** Presigned download, served as an attachment with the sniffed type. */
export async function getChatAttachmentDownloadUrl(
  userId: string,
  attachmentId: string,
): Promise<string> {
  const row = await loadOwned(userId, attachmentId);
  const attachment = toChatAttachment(row);
  if (row.s3Key == null) throw notFound();
  const s3 = await requireS3();
  return generateDownloadUrl(s3, row.s3Bucket, row.s3Key, {
    fileName: attachment.fileName,
    contentType: attachment.contentType,
  });
}

/**
 * Delete an attachment: the S3 objects first, then the row (P4). When S3 is
 * unavailable the row is only marked deleted and the retention cron finishes.
 */
export async function deleteChatAttachment(
  userId: string,
  attachmentId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const row = await loadOwned(userId, attachmentId);
  await db
    .update(aiAttachments)
    .set({ deletedAt: sql`now()` })
    .where(eq(aiAttachments.id, row.id));
  try {
    const s3 = await requireS3();
    await deleteObject(s3, row.s3Bucket, row.quarantineKey);
    if (row.s3Key != null) await deleteObject(s3, row.s3Bucket, row.s3Key);
    await db.delete(aiAttachments).where(eq(aiAttachments.id, row.id));
  } catch (err) {
    log.warn({ err, attachmentId }, 'chat attachment S3 delete failed; the retention cron retries');
  }
}

/**
 * For the conversation engine (lane L2): bind ready attachments to a
 * conversation when a message uses them. Each must be owned by the user, ready,
 * and unbound or already bound to this conversation (else 404). More than
 * `ai.attachments.maxPerMessage` gives 400 `AI_ATTACHMENT_TOO_LARGE`.
 */
export async function claimChatAttachments(
  userId: string,
  conversationId: string,
  attachmentIds: readonly string[],
): Promise<ChatAttachment[]> {
  const ids = [...new Set(attachmentIds)];
  if (ids.length === 0) return [];
  const { maxPerMessage } = await attachmentLimits();
  if (ids.length > maxPerMessage) {
    throw attachmentTooLarge(
      `${String(ids.length)} attachments, the limit per message is ${String(maxPerMessage)}`,
    );
  }
  // One transaction: when any id is not claimable, the throw rolls back the
  // others so a refused message binds nothing.
  const rows = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(aiAttachments)
      .set({ conversationId })
      .where(
        and(
          inArray(aiAttachments.id, ids),
          eq(aiAttachments.userId, userId),
          eq(aiAttachments.status, 'ready'),
          isNull(aiAttachments.deletedAt),
          or(
            isNull(aiAttachments.conversationId),
            eq(aiAttachments.conversationId, conversationId),
          ),
        ),
      )
      .returning();
    if (claimed.length !== ids.length) throw notFound();
    return claimed;
  });
  return rows.map(toChatAttachment);
}

/**
 * For the conversation engine (lane L2): mark every attachment of a deleted
 * conversation deleted. The retention cron removes the S3 objects and rows.
 */
export async function markConversationAttachmentsDeleted(conversationId: string): Promise<number> {
  const rows = await db
    .update(aiAttachments)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(aiAttachments.conversationId, conversationId), isNull(aiAttachments.deletedAt)))
    .returning({ id: aiAttachments.id });
  return rows.length;
}

/**
 * For provider adapters (`AiRequest.resolveAttachment`): the sanitized bytes
 * of a ready attachment owned by the user.
 */
export async function readChatAttachmentBytes(
  userId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; attachment: ChatAttachment }> {
  const row = await loadOwned(userId, attachmentId);
  const attachment = toChatAttachment(row);
  if (row.s3Key == null) throw notFound();
  const s3 = await requireS3();
  const { maxBytes } = await attachmentLimits();
  const read = await readObject(
    s3,
    row.s3Bucket,
    row.s3Key,
    Math.max(maxBytes, attachment.sizeBytes),
  );
  if (read.status !== 'ok') throw notFound();
  return { bytes: read.bytes, attachment };
}
