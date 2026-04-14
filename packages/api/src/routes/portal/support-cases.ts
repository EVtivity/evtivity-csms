// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  supportCases,
  supportCaseMessages,
  supportCaseAttachments,
  supportCaseSessions,
  chargingSessions,
  chargingStations,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { getPubSub } from '../../lib/pubsub.js';
import { errorResponse, paginatedResponse, itemResponse } from '../../lib/response-schemas.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const portalSupportCaseItem = z
  .object({
    id: z.string(),
    caseNumber: z.string(),
    subject: z.string(),
    status: z.string(),
    category: z.string(),
    priority: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const attachmentItem = z
  .object({
    id: z.string(),
    messageId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    contentType: z.string(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const messageItem = z
  .object({
    id: z.string(),
    senderType: z.string(),
    body: z.string(),
    createdAt: z.coerce.date(),
    attachments: z.array(attachmentItem).optional(),
  })
  .passthrough();

const sessionRef = z.object({ id: z.string(), transactionId: z.string().nullable() }).passthrough();

const portalSupportCaseDetail = portalSupportCaseItem
  .extend({
    description: z.string(),
    driverId: z.string().nullable(),
    stationId: z.string().nullable(),
    stationName: z.string().nullable(),
    resolvedAt: z.coerce.date().nullable(),
    sessions: z.array(sessionRef),
    messages: z.array(messageItem),
  })
  .passthrough();

const portalMessageResponse = z
  .object({
    id: z.string(),
    caseId: z.string(),
    senderType: z.string(),
    senderId: z.string().nullable(),
    body: z.string(),
    isInternal: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const uploadUrlResponse = z
  .object({ uploadUrl: z.string(), s3Key: z.string(), s3Bucket: z.string() })
  .passthrough();

const downloadUrlResponse = z.object({ downloadUrl: z.string() }).passthrough();
import {
  getS3Config,
  generateUploadUrl,
  generateDownloadUrl,
  buildS3Key,
} from '../../services/s3.service.js';
import { dispatchOperatorNotification } from '../../services/support-notification.service.js';

const caseIdParams = z.object({ id: ID_PARAMS.supportCaseId.describe('Support case ID') });
const messageIdParams = z.object({
  id: ID_PARAMS.supportCaseId.describe('Support case ID'),
  messageId: z.coerce.number().int().min(1).describe('Message ID'),
});
const attachmentIdParams = z.object({
  id: ID_PARAMS.supportCaseId.describe('Support case ID'),
  messageId: z.coerce.number().int().min(1).describe('Message ID'),
  attachmentId: z.coerce.number().int().min(1).describe('Attachment ID'),
});

const createCaseBody = z.object({
  subject: z.string().min(1).max(255),
  description: z.string().min(1),
  category: z
    .enum([
      'billing_dispute',
      'charging_failure',
      'connector_damage',
      'account_issue',
      'payment_problem',
      'reservation_issue',
      'general_inquiry',
    ])
    .describe('Support case category'),
  sessionId: ID_PARAMS.sessionId.optional().describe('Related charging session ID'),
  stationId: ID_PARAMS.stationId.optional().describe('Related station ID'),
});

const createMessageBody = z.object({
  body: z.string().min(1),
});

const requestUploadUrlBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  fileSize: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
});

const confirmAttachmentBody = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().min(1),
  contentType: z.string().min(1).max(100),
  s3Key: z.string().min(1),
  s3Bucket: z.string().min(1),
});

async function getNextCaseNumber(): Promise<string> {
  const result = await db.execute(sql`SELECT nextval('support_case_number_seq') as val`);
  const seq = Number((result as unknown as Array<{ val: string }>)[0]?.val ?? 1);
  return `CASE-${String(seq).padStart(5, '0')}`;
}

async function notifyCsmsEvent(eventType: string, caseId: string): Promise<void> {
  await getPubSub().publish('csms_events', JSON.stringify({ eventType, caseId }));
}

export function portalSupportCaseRoutes(app: FastifyInstance): void {
  // List driver's support cases
  app.get(
    '/portal/support-cases',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'List support cases for the driver',
        operationId: 'portalListSupportCases',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(portalSupportCaseItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const [data, totalResult] = await Promise.all([
        db
          .select({
            id: supportCases.id,
            caseNumber: supportCases.caseNumber,
            subject: supportCases.subject,
            status: supportCases.status,
            category: supportCases.category,
            priority: supportCases.priority,
            createdAt: supportCases.createdAt,
            updatedAt: supportCases.updatedAt,
          })
          .from(supportCases)
          .where(eq(supportCases.driverId, driverId))
          .orderBy(desc(supportCases.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(supportCases).where(eq(supportCases.driverId, driverId)),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get support case detail (driver view, excludes internal messages)
  app.get(
    '/portal/support-cases/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Get support case details with messages',
        operationId: 'portalGetSupportCase',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        response: {
          200: itemResponse(portalSupportCaseDetail),
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof caseIdParams>;

      const [supportCase] = await db
        .select({
          id: supportCases.id,
          caseNumber: supportCases.caseNumber,
          subject: supportCases.subject,
          description: supportCases.description,
          status: supportCases.status,
          category: supportCases.category,
          priority: supportCases.priority,
          driverId: supportCases.driverId,
          stationId: supportCases.stationId,
          stationName: chargingStations.stationId,
          resolvedAt: supportCases.resolvedAt,
          createdAt: supportCases.createdAt,
          updatedAt: supportCases.updatedAt,
        })
        .from(supportCases)
        .leftJoin(chargingStations, eq(supportCases.stationId, chargingStations.id))
        .where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      if (supportCase.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const sessions = await db
        .select({
          id: supportCaseSessions.sessionId,
          transactionId: chargingSessions.transactionId,
        })
        .from(supportCaseSessions)
        .innerJoin(chargingSessions, eq(supportCaseSessions.sessionId, chargingSessions.id))
        .where(eq(supportCaseSessions.caseId, id));

      // Exclude internal messages
      const messages = await db
        .select({
          id: supportCaseMessages.id,
          senderType: supportCaseMessages.senderType,
          body: supportCaseMessages.body,
          createdAt: supportCaseMessages.createdAt,
        })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.caseId, id), eq(supportCaseMessages.isInternal, false)))
        .orderBy(supportCaseMessages.createdAt);

      const messageIds = messages.map((m) => m.id);
      let attachments: Array<{
        id: number;
        messageId: number;
        fileName: string;
        fileSize: number;
        contentType: string;
        createdAt: Date;
      }> = [];

      if (messageIds.length > 0) {
        attachments = await db
          .select({
            id: supportCaseAttachments.id,
            messageId: supportCaseAttachments.messageId,
            fileName: supportCaseAttachments.fileName,
            fileSize: supportCaseAttachments.fileSize,
            contentType: supportCaseAttachments.contentType,
            createdAt: supportCaseAttachments.createdAt,
          })
          .from(supportCaseAttachments)
          .where(inArray(supportCaseAttachments.messageId, messageIds));
      }

      const attachmentsByMessage = new Map<number, typeof attachments>();
      for (const att of attachments) {
        const existing = attachmentsByMessage.get(att.messageId) ?? [];
        existing.push(att);
        attachmentsByMessage.set(att.messageId, existing);
      }

      const messagesWithAttachments = messages.map((m) => ({
        ...m,
        attachments: attachmentsByMessage.get(m.id) ?? [],
      }));

      return { ...supportCase, sessions, messages: messagesWithAttachments };
    },
  );

  // Create support case (driver)
  app.post(
    '/portal/support-cases',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Create a new support case',
        operationId: 'portalCreateSupportCase',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createCaseBody),
        response: { 200: itemResponse(portalSupportCaseItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createCaseBody>;

      const caseNumber = await getNextCaseNumber();

      // Auto-populate stationId from session if provided
      let stationId = body.stationId ?? null;
      if (stationId == null && body.sessionId != null) {
        const [session] = await db
          .select({ stationId: chargingSessions.stationId })
          .from(chargingSessions)
          .where(eq(chargingSessions.id, body.sessionId));
        stationId = session?.stationId ?? null;
      }

      const [newCase] = await db
        .insert(supportCases)
        .values({
          caseNumber,
          subject: body.subject,
          description: body.description,
          category: body.category,
          priority: 'medium',
          driverId,
          stationId,
          createdByDriver: true,
        })
        .returning();

      if (newCase == null) {
        throw new Error('Failed to create support case');
      }

      // Link session via junction table
      if (body.sessionId != null) {
        await db.insert(supportCaseSessions).values({
          caseId: newCase.id,
          sessionId: body.sessionId,
        });
      }

      // Create initial message
      await db.insert(supportCaseMessages).values({
        caseId: newCase.id,
        senderType: 'driver',
        senderId: driverId,
        body: body.description,
        isInternal: false,
      });

      // Notify operators
      void dispatchOperatorNotification('new_case', newCase.id, caseNumber, body.subject, null);

      void notifyCsmsEvent('supportCase.created', newCase.id);

      return newCase;
    },
  );

  // Driver reply to case
  app.post(
    '/portal/support-cases/:id/messages',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Reply to a support case',
        operationId: 'portalCreateSupportMessage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(createMessageBody),
        response: {
          200: itemResponse(portalMessageResponse),
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const body = request.body as z.infer<typeof createMessageBody>;

      const [supportCase] = await db.select().from(supportCases).where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      if (supportCase.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [message] = await db
        .insert(supportCaseMessages)
        .values({
          caseId: id,
          senderType: 'driver',
          senderId: driverId,
          body: body.body,
          isInternal: false,
        })
        .returning();

      // Notify operators
      void dispatchOperatorNotification(
        'driver_reply',
        supportCase.id,
        supportCase.caseNumber,
        supportCase.subject,
        supportCase.assignedTo,
      );

      void notifyCsmsEvent('supportCase.newMessage', id);

      return message;
    },
  );

  // Request presigned upload URL (driver)
  app.post(
    '/portal/support-cases/:id/messages/:messageId/attachments/upload-url',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Request a presigned S3 upload URL for an attachment',
        operationId: 'portalRequestAttachmentUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(requestUploadUrlBody),
        response: {
          200: itemResponse(uploadUrlResponse),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id, messageId } = request.params as z.infer<typeof messageIdParams>;
      const body = request.body as z.infer<typeof requestUploadUrlBody>;

      // Verify ownership
      const [supportCase] = await db
        .select({ driverId: supportCases.driverId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }
      if (supportCase.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [message] = await db
        .select({ id: supportCaseMessages.id })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
        return;
      }

      const fileId = crypto.randomUUID();
      const key = buildS3Key(id, messageId, fileId, body.fileName);
      const uploadUrl = await generateUploadUrl(s3, key, body.contentType);

      return { uploadUrl, s3Key: key, s3Bucket: s3.bucket };
    },
  );

  // Confirm attachment (driver)
  app.post(
    '/portal/support-cases/:id/messages/:messageId/attachments',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Confirm an attachment after S3 upload',
        operationId: 'portalConfirmAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(confirmAttachmentBody),
        response: { 200: itemResponse(attachmentItem), 403: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id, messageId } = request.params as z.infer<typeof messageIdParams>;
      const body = request.body as z.infer<typeof confirmAttachmentBody>;

      // Verify ownership
      const [supportCase] = await db
        .select({ driverId: supportCases.driverId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (supportCase == null || supportCase.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [message] = await db
        .select({ id: supportCaseMessages.id })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      const [attachment] = await db
        .insert(supportCaseAttachments)
        .values({
          messageId,
          fileName: body.fileName,
          fileSize: body.fileSize,
          contentType: body.contentType,
          s3Key: body.s3Key,
          s3Bucket: body.s3Bucket,
        })
        .returning();

      return attachment;
    },
  );

  // Download attachment (driver, verify ownership + not internal)
  app.get(
    '/portal/support-cases/:id/messages/:messageId/attachments/:attachmentId/download-url',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Support'],
        summary: 'Get a presigned download URL for an attachment',
        operationId: 'portalGetAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          200: itemResponse(downloadUrlResponse),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id, messageId, attachmentId } = request.params as z.infer<typeof attachmentIdParams>;

      // Verify ownership
      const [supportCase] = await db
        .select({ driverId: supportCases.driverId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (supportCase == null || supportCase.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      // Verify message is not internal
      const [message] = await db
        .select({ isInternal: supportCaseMessages.isInternal })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      if (message.isInternal) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [attachment] = await db
        .select()
        .from(supportCaseAttachments)
        .where(
          and(
            eq(supportCaseAttachments.id, attachmentId),
            eq(supportCaseAttachments.messageId, messageId),
          ),
        );

      if (attachment == null) {
        await reply
          .status(404)
          .send({ error: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
        return;
      }

      const downloadUrl = await generateDownloadUrl(s3, attachment.s3Bucket, attachment.s3Key);
      return { downloadUrl };
    },
  );
}
