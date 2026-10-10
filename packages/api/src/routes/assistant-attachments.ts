// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
  confirmChatAttachment,
  deleteChatAttachment,
  getChatAttachmentDownloadUrl,
  requestChatAttachmentUpload,
} from '../services/ai/attachments/chat-attachments.service.js';

// Chat attachments follow the assistant permission (migration 0373): reads
// need aiAssistant:read, uploads and deletes aiAssistant:write.
const READ = 'aiAssistant:read';
const WRITE = 'aiAssistant:write';

const attachmentIdParams = z.object({
  id: z.string().uuid().describe('Attachment ID'),
});

const uploadUrlBody = z.object({
  fileName: z.string().min(1).max(255).describe('File name as chosen by the user'),
  contentType: z
    .string()
    .max(100)
    .describe(
      'MIME type: JPEG, PNG, WebP, GIF, PDF, CSV, plain text or log, JSON or JSONL. Empty or application/octet-stream falls back to the file extension.',
    ),
  fileSize: z
    .number()
    .int()
    .min(1)
    .describe('File size in bytes, at most the ai.attachments.maxBytes setting (default 10 MB)'),
});

const uploadUrlResponse = z
  .object({
    attachmentId: z.string().describe('Attachment ID to confirm after the upload'),
    uploadUrl: z
      .string()
      .describe(
        'Presigned S3 POST URL. Send a multipart/form-data POST with every entry of fields, then the file as the last field named file. S3 enforces the size limit and the Content-Type.',
      ),
    fields: z.record(z.string()).describe('Form fields to send unchanged before the file field'),
    expiresAt: z.coerce.date().describe('Time after which S3 refuses the POST'),
  })
  .passthrough();

const attachmentResponse = z
  .object({
    id: z.string().describe('Attachment ID'),
    fileName: z
      .string()
      .describe('Sanitized file name (a re-encoded image gets the extension of its new type)'),
    contentType: z
      .string()
      .describe('Content type sniffed from the file (images are stored as JPEG or PNG)'),
    kind: z.enum(['image', 'pdf', 'text']).describe('Attachment kind'),
    sizeBytes: z.number().int().describe('Size of the stored (sanitized) file in bytes'),
    width: z.number().int().nullable().describe('Image width in pixels after re-encoding'),
    height: z.number().int().nullable().describe('Image height in pixels after re-encoding'),
    pageCount: z.number().int().nullable().describe('PDF page count'),
    conversationId: z
      .string()
      .nullable()
      .describe('Conversation that uses the attachment, null until a message uses it'),
    createdAt: z.coerce.date().describe('Time the upload was requested'),
  })
  .passthrough();

const downloadUrlResponse = z
  .object({
    downloadUrl: z
      .string()
      .describe('Presigned S3 GET URL that downloads the file as an attachment'),
  })
  .passthrough();

const notFound = errorWith('Attachment not found', [ERROR_CODES.ATTACHMENT_NOT_FOUND]);

/**
 * AI chat attachments (plan 3.8). Each attachment belongs to the user who
 * uploaded it; every route answers 404 for another user's attachment.
 */
export function assistantAttachmentRoutes(app: FastifyInstance): void {
  app.post(
    '/assistant/attachments/upload-url',
    {
      onRequest: [authorize(WRITE)],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Request an upload URL for an AI chat attachment',
        description:
          'Returns a presigned S3 POST into quarantine. The type must be allowlisted and the size within ai.attachments.maxBytes; S3 enforces both. Confirm the upload afterwards.',
        operationId: 'requestAssistantAttachmentUpload',
        security: [{ bearerAuth: [] }],
        body: zodSchema(uploadUrlBody),
        response: {
          200: itemResponse(uploadUrlResponse),
          400: errorWith('Storage not configured, or the file type or size is not allowed', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.AI_ATTACHMENT_TYPE_NOT_ALLOWED,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      return requestChatAttachmentUpload(userId, request.body as z.infer<typeof uploadUrlBody>);
    },
  );

  app.post(
    '/assistant/attachments/:id/confirm',
    {
      onRequest: [authorize(WRITE)],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Confirm an uploaded AI chat attachment',
        description:
          'Reads the uploaded file, checks its bytes against the declared type, re-encodes images (metadata stripped, long edge at most 2576 px), checks PDFs (not encrypted, page limit) and text (UTF-8, cut to 2 MB) and stores the clean file. Confirming again returns the stored attachment.',
        operationId: 'confirmAssistantAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          200: itemResponse(attachmentResponse),
          400: errorWith('The file was refused', [
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
          ]),
          404: notFound,
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof attachmentIdParams>;
      return confirmChatAttachment(userId, id, request.log);
    },
  );

  app.get(
    '/assistant/attachments/:id/download-url',
    {
      onRequest: [authorize(READ)],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Get a download URL for an AI chat attachment',
        operationId: 'getAssistantAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          200: itemResponse(downloadUrlResponse),
          400: errorWith('S3 not configured', [ERROR_CODES.STORAGE_NOT_CONFIGURED]),
          404: notFound,
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof attachmentIdParams>;
      return { downloadUrl: await getChatAttachmentDownloadUrl(userId, id) };
    },
  );

  app.delete(
    '/assistant/attachments/:id',
    {
      onRequest: [authorize(WRITE)],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Delete an AI chat attachment',
        operationId: 'deleteAssistantAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          204: { type: 'null' as const },
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof attachmentIdParams>;
      await deleteChatAttachment(userId, id, request.log);
      await reply.status(204).send();
    },
  );
}
