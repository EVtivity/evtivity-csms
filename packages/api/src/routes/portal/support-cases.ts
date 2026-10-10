// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  supportCases,
  supportCaseMessages,
  supportCaseAttachments,
  supportCaseSessions,
  supportCaseStatusEnum,
  supportCaseCategoryEnum,
  supportCasePriorityEnum,
  supportCaseMessageSenderEnum,
  chargingSessions,
  chargingStations,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { notifySupportCaseEvent } from '../../lib/support-case-events.js';
import { paginatedResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const portalSupportCaseItem = z
  .object({
    id: z.string().describe('Support case ID (nanoid prefixed with cas_)'),
    caseNumber: z.string().describe('Human-readable case number, e.g. CASE-00042'),
    subject: z.string().max(255).describe('Case subject line'),
    status: z
      .enum(supportCaseStatusEnum.enumValues)
      .describe('Case status (open, in_progress, waiting_on_driver, resolved, closed)'),
    category: z
      .enum(supportCaseCategoryEnum.enumValues)
      .describe(
        'Case category (billing_dispute, charging_failure, connector_damage, account_issue, payment_problem, reservation_issue, general_inquiry)',
      ),
    priority: z
      .enum(supportCasePriorityEnum.enumValues)
      .describe('Case priority (low, medium, high, urgent)'),
    createdAt: z.coerce.date().describe('Timestamp the case was opened'),
    updatedAt: z.coerce.date().describe('Timestamp the case was last updated'),
  })
  .passthrough();

const attachmentItem = z
  .object({
    id: z.number().int().describe('Attachment ID'),
    messageId: z.number().int().describe('Parent message ID'),
    fileName: z.string().max(255).describe('Original uploaded file name'),
    fileSize: z.number().int().min(0).describe('File size in bytes'),
    contentType: z.string().max(100).describe('MIME content type'),
    createdAt: z.coerce.date().describe('Timestamp the attachment was uploaded'),
  })
  .passthrough();

const messageItem = z
  .object({
    id: z.number().int().describe('Message ID'),
    senderType: z
      .enum(supportCaseMessageSenderEnum.enumValues)
      .describe('Who sent the message (driver, operator, system)'),
    body: z.string().describe('Message body text'),
    createdAt: z.coerce.date().describe('Timestamp the message was sent'),
    attachments: z
      .array(attachmentItem)
      .optional()
      .describe('Attachments uploaded with this message'),
  })
  .passthrough();

const sessionRef = z
  .object({
    id: z.string().describe('Charging session ID'),
    transactionId: z.string().nullable().describe('OCPP transaction ID for the session'),
  })
  .passthrough();

const portalSupportCaseDetail = portalSupportCaseItem
  .extend({
    description: z.string().describe('Original case description from the driver'),
    driverId: z.string().nullable().describe('Driver ID that owns the case'),
    stationId: z.string().nullable().describe('Linked station ID, if any'),
    stationName: z.string().nullable().describe('OCPP station identity for the linked station'),
    resolvedAt: z.coerce.date().nullable().describe('Timestamp the case was resolved'),
    sessions: z.array(sessionRef).describe('Charging sessions linked to this case'),
    messages: z
      .array(messageItem)
      .describe('Chronologically ordered driver-visible messages on the case'),
  })
  .passthrough();

const portalMessageResponse = z
  .object({
    id: z.number().int().describe('Message ID'),
    caseId: z.string().describe('Parent case ID'),
    senderType: z
      .enum(supportCaseMessageSenderEnum.enumValues)
      .describe('Who sent the message (driver, operator, system)'),
    senderId: z
      .string()
      .nullable()
      .describe('User or driver ID of the sender, null for system messages'),
    body: z.string().describe('Message body text'),
    isInternal: z
      .boolean()
      .describe('Whether the message is an internal note (always false for portal replies)'),
    createdAt: z.coerce.date().describe('Timestamp the message was sent'),
  })
  .passthrough();

const uploadUrlResponse = z
  .object({
    uploadUrl: z
      .string()
      .describe(
        'Presigned S3 POST URL. Send a multipart/form-data POST with every entry of fields, then the file as the last field named file. S3 enforces the size limit and the Content-Type.',
      ),
    fields: z.record(z.string()).describe('Form fields to send unchanged before the file field'),
    s3Key: z
      .string()
      .describe('Quarantine key of the upload. Pass it to the confirm endpoint after the POST.'),
    expiresAt: z.coerce.date().describe('Time after which S3 refuses the POST'),
  })
  .passthrough();

const downloadUrlResponse = z
  .object({
    downloadUrl: z.string().describe('Presigned S3 GET URL valid for a short time'),
  })
  .passthrough();
import {
  confirmSupportAttachment,
  requestSupportAttachmentUpload,
  supportAttachmentDownloadUrl,
} from '../../services/ai/attachments/support-attachments.js';
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
  description: z.string().min(1).max(5000),
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
  stationId: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Related station OCPP identity (e.g. CS-0439)'),
});

const createMessageBody = z.object({
  body: z.string().min(1).max(10000),
});

const requestUploadUrlBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z
    .string()
    .max(100)
    .describe(
      'MIME type of the file: JPEG, PNG, WebP, GIF, PDF, CSV, plain text or log, JSON or JSONL. Empty or application/octet-stream falls back to the file extension.',
    ),
  fileSize: z
    .number()
    .int()
    .min(1)
    .describe('File size in bytes, at most the ai.attachments.maxBytes setting (default 10 MB)'),
});

const confirmAttachmentBody = z.object({
  s3Key: z
    .string()
    .min(1)
    .max(1024)
    .describe('Quarantine key returned by the upload URL request for this message'),
});

async function getNextCaseNumber(): Promise<string> {
  const result = await db.execute(sql`SELECT nextval('support_case_number_seq') as val`);
  const seq = Number((result as unknown as Array<{ val: string }>)[0]?.val ?? 1);
  return `CASE-${String(seq).padStart(5, '0')}`;
}

/** SQL: the message is the driver's own, non-internal message on the case. */
function driverOwnMessageCondition(caseId: string, messageId: number, driverId: string) {
  return and(
    eq(supportCaseMessages.id, messageId),
    eq(supportCaseMessages.caseId, caseId),
    eq(supportCaseMessages.senderType, 'driver'),
    eq(supportCaseMessages.senderId, driverId),
    eq(supportCaseMessages.isInternal, false),
  );
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
          .orderBy(desc(supportCases.createdAt), desc(supportCases.id))
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
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
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
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Sessions and messages are independent — fan in parallel so the
      // portal detail page is bounded by the slower query (matches the
      // operator detail endpoint's pattern).
      const [sessions, messages] = await Promise.all([
        db
          .select({
            id: supportCaseSessions.sessionId,
            transactionId: chargingSessions.transactionId,
          })
          .from(supportCaseSessions)
          .innerJoin(chargingSessions, eq(supportCaseSessions.sessionId, chargingSessions.id))
          // Only the driver's own sessions: an operator could have linked a
          // session of another driver before linking checked the driver.
          .where(and(eq(supportCaseSessions.caseId, id), eq(chargingSessions.driverId, driverId))),
        // Exclude internal messages — drivers must not see operator notes.
        db
          .select({
            id: supportCaseMessages.id,
            senderType: supportCaseMessages.senderType,
            body: supportCaseMessages.body,
            createdAt: supportCaseMessages.createdAt,
          })
          .from(supportCaseMessages)
          .where(and(eq(supportCaseMessages.caseId, id), eq(supportCaseMessages.isInternal, false)))
          .orderBy(supportCaseMessages.createdAt),
      ]);

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
        response: {
          200: itemResponse(portalSupportCaseItem),
          404: errorWith('Session or station not found', [
            ERROR_CODES.SESSION_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createCaseBody>;

      // Reject sessionId that does not belong to this driver. Without this
      // guard a driver can attach another driver's session to a case, polluting
      // operator workflows and letting them appear in disputes for sessions
      // they did not run. 404 (not 403) to avoid leaking session existence.
      let sessionStationId: string | null = null;
      if (body.sessionId != null) {
        const [session] = await db
          .select({
            driverId: chargingSessions.driverId,
            stationId: chargingSessions.stationId,
          })
          .from(chargingSessions)
          .where(eq(chargingSessions.id, body.sessionId));
        if (session == null || session.driverId !== driverId) {
          await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
          return;
        }
        sessionStationId = session.stationId;
      }

      // The portal speaks the OCPP station identity (e.g. CS-0439), not the
      // internal sta_ id. Resolve it to the FK the support_cases row stores.
      let resolvedStationId: string | null = null;
      if (body.stationId != null) {
        const [station] = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(eq(chargingStations.stationId, body.stationId));
        if (station == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        // The case is scoped to its station's site on the operator side: a
        // station that differs from the session's station would show the
        // session's case to the operators of another site.
        if (sessionStationId != null && station.id !== sessionStationId) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        resolvedStationId = station.id;
      }

      const caseNumber = await getNextCaseNumber();

      const stationId = resolvedStationId ?? sessionStationId;

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

      void notifySupportCaseEvent('supportCase.created', newCase.id, driverId);

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
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
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
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
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

      void notifySupportCaseEvent('supportCase.newMessage', id, driverId);

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
        description:
          'Returns a presigned S3 POST into quarantine for an attachment on one of your own messages. The type must be allowlisted and the size within the limit; S3 enforces both. Confirm the upload afterwards.',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(requestUploadUrlBody),
        response: {
          200: itemResponse(uploadUrlResponse),
          400: errorWith('Storage not configured, or the file type or size is not allowed', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.AI_ATTACHMENT_TYPE_NOT_ALLOWED,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
          404: errorWith('Not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.MESSAGE_NOT_FOUND,
          ]),
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

      if (supportCase == null || supportCase.driverId !== driverId) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // A driver attaches files only to its own messages on the case, never
      // to an operator message or an internal note.
      const [message] = await db
        .select({ id: supportCaseMessages.id })
        .from(supportCaseMessages)
        .where(driverOwnMessageCondition(id, messageId, driverId));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      return requestSupportAttachmentUpload(id, messageId, body);
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
        description:
          'Reads the uploaded file, checks its bytes against the declared type, re-encodes images (metadata stripped), checks PDFs and text, stores the clean file and records it on the message. Confirming the same key again returns the stored attachment.',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(confirmAttachmentBody),
        response: {
          200: itemResponse(attachmentItem),
          400: errorWith('Upload key invalid, or the file was refused', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
          ]),
          404: errorWith('Support case or message not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.MESSAGE_NOT_FOUND,
          ]),
        },
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
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // A driver attaches files only to its own messages on the case, never
      // to an operator message or an internal note.
      const [message] = await db
        .select({ id: supportCaseMessages.id })
        .from(supportCaseMessages)
        .where(driverOwnMessageCondition(id, messageId, driverId));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      // The service accepts only a quarantine key issued for this case and
      // message, so a driver cannot register another driver's object and then
      // download it through this case.
      const { attachment } = await confirmSupportAttachment(id, messageId, body.s3Key, request.log);
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
          400: errorWith('S3 not configured', [ERROR_CODES.STORAGE_NOT_CONFIGURED]),
          404: errorWith('Not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.MESSAGE_NOT_FOUND,
            ERROR_CODES.ATTACHMENT_NOT_FOUND,
          ]),
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
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Verify message is not internal. Internal messages are filtered out
      // of the portal detail GET; treat any attempted access here as not
      // found rather than 403 so the driver can't probe their existence.
      const [message] = await db
        .select({ isInternal: supportCaseMessages.isInternal })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      if (message == null || message.isInternal) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
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

      return { downloadUrl: await supportAttachmentDownloadUrl(attachment) };
    },
  );
}
