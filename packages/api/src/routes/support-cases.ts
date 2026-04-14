// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count, ilike, or, inArray } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  supportCases,
  supportCaseMessages,
  supportCaseAttachments,
  supportCaseSessions,
  supportCaseReads,
  drivers,
  users,
  chargingSessions,
  chargingStations,
  paymentRecords,
} from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import { handleSupportAiAssist } from '../services/ai/support-assist.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import type { JwtPayload } from '../plugins/auth.js';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';

const supportCaseListItem = z
  .object({
    id: z.string(),
    caseNumber: z.string(),
    subject: z.string(),
    status: z.string(),
    category: z.string(),
    priority: z.string(),
    createdByDriver: z.boolean(),
    driverName: z.string().nullable(),
    assignedToName: z.string().nullable(),
    assignedTo: z.string().nullable(),
    driverId: z.string().nullable(),
    isRead: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const supportCaseItem = z
  .object({
    id: z.string(),
    caseNumber: z.string(),
    subject: z.string(),
    description: z.string(),
    status: z.string(),
    category: z.string(),
    priority: z.string(),
    driverId: z.string().nullable(),
    stationId: z.string().nullable(),
    assignedTo: z.string().nullable(),
    createdByDriver: z.boolean(),
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

const supportCaseMessageItem = z
  .object({
    id: z.string(),
    senderType: z.string(),
    senderId: z.string().nullable(),
    body: z.string(),
    isInternal: z.boolean(),
    createdAt: z.coerce.date(),
    attachments: z.array(attachmentItem).optional(),
  })
  .passthrough();

const sessionRef = z.object({ id: z.string(), transactionId: z.string().nullable() }).passthrough();

const supportCaseDetail = supportCaseItem
  .extend({
    driverName: z.string().nullable(),
    driverEmail: z.string().nullable(),
    stationName: z.string().nullable(),
    assignedToName: z.string().nullable(),
    resolvedAt: z.coerce.date().nullable(),
    closedAt: z.coerce.date().nullable(),
    sessions: z.array(sessionRef),
    messages: z.array(supportCaseMessageItem),
  })
  .passthrough();

const uploadUrlResponse = z
  .object({ uploadUrl: z.string(), s3Key: z.string(), s3Bucket: z.string() })
  .passthrough();

const downloadUrlResponse = z.object({ downloadUrl: z.string() }).passthrough();

const paymentRecordItem = z
  .object({
    id: z.string(),
    sessionId: z.string().nullable(),
    driverId: z.string().nullable(),
    status: z.string(),
    currency: z.string(),
    capturedAmountCents: z.number().nullable(),
    refundedAmountCents: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();
import {
  getS3Config,
  generateUploadUrl,
  generateDownloadUrl,
  deleteObject,
  buildS3Key,
} from '../services/s3.service.js';
import { getStripeConfig, createRefund } from '../services/stripe.service.js';
import { authorize } from '../middleware/rbac.js';

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

const listCasesQuery = paginationQuery.extend({
  status: z
    .enum(['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed'])
    .optional()
    .describe('Filter by case status'),
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
    .optional()
    .describe('Filter by case category'),
  priority: z
    .enum(['low', 'medium', 'high', 'urgent'])
    .optional()
    .describe('Filter by priority level'),
  assignedTo: ID_PARAMS.userId.optional().describe('Filter by assigned operator ID'),
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
  priority: z
    .enum(['low', 'medium', 'high', 'urgent'])
    .default('medium')
    .describe('Priority level, defaults to medium'),
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to link to this case'),
  sessionIds: z.array(ID_PARAMS.sessionId).optional().describe('Charging session IDs to link'),
  stationId: ID_PARAMS.stationId.optional().describe('Station ID related to this case'),
  assignedTo: ID_PARAMS.userId.optional().describe('Operator ID to assign the case to'),
});

const updateCaseBody = z.object({
  status: z
    .enum(['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed'])
    .optional()
    .describe('New case status'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority level'),
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
    .optional()
    .describe('New case category'),
  assignedTo: ID_PARAMS.userId
    .nullable()
    .optional()
    .describe('Operator ID to assign, or null to unassign'),
  addSessionIds: z
    .array(ID_PARAMS.sessionId)
    .optional()
    .describe('Session IDs to link to this case'),
  removeSessionIds: z
    .array(ID_PARAMS.sessionId)
    .optional()
    .describe('Session IDs to unlink from this case'),
});

const createMessageBody = z.object({
  body: z.string().min(1),
  isInternal: z.boolean().default(false).describe('If true, message is only visible to operators'),
});

const requestUploadUrlBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).describe('MIME type of the file'),
  fileSize: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .describe('File size in bytes, max 10 MB'),
});

const confirmAttachmentBody = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().min(1).describe('File size in bytes'),
  contentType: z.string().min(1).max(100).describe('MIME type of the file'),
  s3Key: z.string().min(1).describe('S3 object key returned from the upload URL request'),
  s3Bucket: z.string().min(1).describe('S3 bucket name returned from the upload URL request'),
});

const refundBody = z.object({
  sessionId: z
    .string()
    .uuid()
    .describe('Charging session UUID to refund (must be linked to this case)'),
  amountCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Partial refund amount in cents. Omit for full refund.'),
});

async function getNextCaseNumber(): Promise<string> {
  const result = await db.execute(sql`SELECT nextval('support_case_number_seq') as val`);
  const seq = Number((result as unknown as Array<{ val: string }>)[0]?.val ?? 1);
  return `CASE-${String(seq).padStart(5, '0')}`;
}

async function notifyCsmsEvent(eventType: string, caseId: string): Promise<void> {
  await getPubSub().publish('csms_events', JSON.stringify({ eventType, caseId }));
}

/**
 * Build a SQL condition that filters support cases by site access.
 * Cases with no stationId remain visible to all users.
 * Cases with a stationId are filtered by the station's siteId.
 */
function buildSiteAccessCondition(siteIds: string[]) {
  return or(
    sql`${supportCases.stationId} IS NULL`,
    inArray(
      sql`(SELECT ${chargingStations.siteId} FROM ${chargingStations} WHERE ${chargingStations.id} = ${supportCases.stationId})`,
      siteIds,
    ),
  );
}

/**
 * Check if a support case is accessible to the user based on site access.
 * Returns true if accessible, false otherwise.
 */
async function isCaseAccessible(
  caseStationId: string | null,
  siteIds: string[] | null,
): Promise<boolean> {
  if (siteIds == null) return true;
  if (caseStationId == null) return true;
  if (siteIds.length === 0) return false;

  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, caseStationId));

  if (station == null) return true;
  if (station.siteId == null) return true;
  return siteIds.includes(station.siteId);
}

export function supportCaseRoutes(app: FastifyInstance): void {
  // List support cases
  app.get(
    '/support-cases',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'List support cases',
        operationId: 'listSupportCases',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listCasesQuery),
        response: { 200: paginatedResponse(supportCaseListItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof listCasesQuery>;
      const { page, limit, search } = query;
      const offset = (page - 1) * limit;
      const { userId } = request.user as JwtPayload;

      const accessibleSiteIds = await getUserSiteIds(userId);

      const conditions = [];
      if (accessibleSiteIds != null) {
        if (accessibleSiteIds.length === 0) {
          conditions.push(sql`${supportCases.stationId} IS NULL`);
        } else {
          conditions.push(buildSiteAccessCondition(accessibleSiteIds));
        }
      }
      if (query.status != null) {
        conditions.push(eq(supportCases.status, query.status));
      }
      if (query.category != null) {
        conditions.push(eq(supportCases.category, query.category));
      }
      if (query.priority != null) {
        conditions.push(eq(supportCases.priority, query.priority));
      }
      if (query.assignedTo != null) {
        conditions.push(eq(supportCases.assignedTo, query.assignedTo));
      }
      if (search != null && search !== '') {
        conditions.push(
          or(
            ilike(supportCases.id, `%${search}%`),
            ilike(supportCases.subject, `%${search}%`),
            ilike(supportCases.caseNumber, `%${search}%`),
          ),
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, totalResult] = await Promise.all([
        db
          .select({
            id: supportCases.id,
            caseNumber: supportCases.caseNumber,
            subject: supportCases.subject,
            status: supportCases.status,
            category: supportCases.category,
            priority: supportCases.priority,
            createdByDriver: supportCases.createdByDriver,
            driverName: sql<
              string | null
            >`CASE WHEN ${drivers.id} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
            assignedToName: sql<
              string | null
            >`CASE WHEN ${users.id} IS NOT NULL THEN ${users.firstName} || ' ' || ${users.lastName} ELSE NULL END`,
            assignedTo: supportCases.assignedTo,
            driverId: supportCases.driverId,
            isRead: sql<boolean>`CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM ${supportCaseReads}
                WHERE ${supportCaseReads.caseId} = ${supportCases.id}
                AND ${supportCaseReads.userId} = ${userId}
              ) THEN false
              WHEN EXISTS (
                SELECT 1 FROM ${supportCaseMessages}
                WHERE ${supportCaseMessages.caseId} = ${supportCases.id}
                AND ${supportCaseMessages.senderType} = 'driver'
                AND ${supportCaseMessages.createdAt} > (
                  SELECT ${supportCaseReads.lastReadAt} FROM ${supportCaseReads}
                  WHERE ${supportCaseReads.caseId} = ${supportCases.id}
                  AND ${supportCaseReads.userId} = ${userId}
                )
              ) THEN false
              ELSE true
            END`,
            createdAt: supportCases.createdAt,
          })
          .from(supportCases)
          .leftJoin(drivers, eq(supportCases.driverId, drivers.id))
          .leftJoin(users, eq(supportCases.assignedTo, users.id))
          .where(where)
          .orderBy(desc(supportCases.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(supportCases).where(where),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get unread support case count
  app.get(
    '/support-cases/unread-count',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get unread support case count for the current operator',
        operationId: 'getUnreadSupportCaseCount',
        security: [{ bearerAuth: [] }],
        response: {
          200: zodSchema(z.object({ count: z.number() }).passthrough()),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;

      const accessibleSiteIds = await getUserSiteIds(userId);

      const conditions = [
        eq(supportCases.assignedTo, userId),
        sql`${supportCases.status} NOT IN ('resolved', 'closed')`,
        sql`(
          NOT EXISTS (
            SELECT 1 FROM ${supportCaseReads}
            WHERE ${supportCaseReads.caseId} = ${supportCases.id}
            AND ${supportCaseReads.userId} = ${userId}
          )
          OR EXISTS (
            SELECT 1 FROM ${supportCaseMessages}
            WHERE ${supportCaseMessages.caseId} = ${supportCases.id}
            AND ${supportCaseMessages.senderType} = 'driver'
            AND ${supportCaseMessages.createdAt} > (
              SELECT ${supportCaseReads.lastReadAt} FROM ${supportCaseReads}
              WHERE ${supportCaseReads.caseId} = ${supportCases.id}
              AND ${supportCaseReads.userId} = ${userId}
            )
          )
        )`,
      ];

      if (accessibleSiteIds != null) {
        if (accessibleSiteIds.length === 0) {
          conditions.push(sql`${supportCases.stationId} IS NULL`);
        } else {
          const siteCondition = buildSiteAccessCondition(accessibleSiteIds);
          if (siteCondition != null) conditions.push(siteCondition);
        }
      }

      const result = await db
        .select({ count: count() })
        .from(supportCases)
        .where(and(...conditions));

      return { count: result[0]?.count ?? 0 };
    },
  );

  // Get support case detail
  app.get(
    '/support-cases/:id',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get support case detail',
        operationId: 'getSupportCase',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        response: { 200: itemResponse(supportCaseDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const { userId } = request.user as JwtPayload;

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
          driverName: sql<
            string | null
          >`CASE WHEN ${drivers.id} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
          driverEmail: drivers.email,
          stationId: supportCases.stationId,
          stationName: chargingStations.stationId,
          assignedTo: supportCases.assignedTo,
          assignedToName: sql<
            string | null
          >`CASE WHEN ${users.id} IS NOT NULL THEN ${users.firstName} || ' ' || ${users.lastName} ELSE NULL END`,
          createdByDriver: supportCases.createdByDriver,
          resolvedAt: supportCases.resolvedAt,
          closedAt: supportCases.closedAt,
          createdAt: supportCases.createdAt,
          updatedAt: supportCases.updatedAt,
        })
        .from(supportCases)
        .leftJoin(drivers, eq(supportCases.driverId, drivers.id))
        .leftJoin(users, eq(supportCases.assignedTo, users.id))
        .leftJoin(chargingStations, eq(supportCases.stationId, chargingStations.id))
        .where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const siteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(supportCase.stationId, siteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const sessions = await db
        .select({
          id: supportCaseSessions.sessionId,
          transactionId: chargingSessions.transactionId,
          stationName: chargingStations.stationId,
          driverName: sql<
            string | null
          >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN COALESCE(${drivers.firstName}, '') || ' ' || COALESCE(${drivers.lastName}, '') ELSE NULL END`,
          status: chargingSessions.status,
        })
        .from(supportCaseSessions)
        .innerJoin(chargingSessions, eq(supportCaseSessions.sessionId, chargingSessions.id))
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .where(eq(supportCaseSessions.caseId, id));

      const messages = await db
        .select({
          id: supportCaseMessages.id,
          senderType: supportCaseMessages.senderType,
          senderId: supportCaseMessages.senderId,
          body: supportCaseMessages.body,
          isInternal: supportCaseMessages.isInternal,
          createdAt: supportCaseMessages.createdAt,
        })
        .from(supportCaseMessages)
        .where(eq(supportCaseMessages.caseId, id))
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

  // Mark support case as read
  app.post(
    '/support-cases/:id/read',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Mark a support case as read by the current operator',
        operationId: 'markSupportCaseRead',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const { userId } = request.user as JwtPayload;

      const [caseRow] = await db
        .select({ stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (caseRow == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const readSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(caseRow.stationId, readSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      await db
        .insert(supportCaseReads)
        .values({ userId, caseId: id, lastReadAt: new Date() })
        .onConflictDoUpdate({
          target: [supportCaseReads.userId, supportCaseReads.caseId],
          set: { lastReadAt: new Date() },
        });

      return { success: true };
    },
  );

  // Create support case
  app.post(
    '/support-cases',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Create a support case',
        operationId: 'createSupportCase',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createCaseBody),
        response: { 200: itemResponse(supportCaseItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createCaseBody>;
      const { userId } = request.user as JwtPayload;

      if (body.stationId != null) {
        const createSiteIds = await getUserSiteIds(userId);
        if (!(await isCaseAccessible(body.stationId, createSiteIds))) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }

      const caseNumber = await getNextCaseNumber();

      const [newCase] = await db
        .insert(supportCases)
        .values({
          caseNumber,
          subject: body.subject,
          description: body.description,
          category: body.category,
          priority: body.priority,
          driverId: body.driverId ?? null,
          stationId: body.stationId ?? null,
          assignedTo: body.assignedTo ?? null,
          createdByDriver: false,
        })
        .returning();

      if (newCase == null) {
        throw new Error('Failed to create support case');
      }

      // Link sessions via junction table
      if (body.sessionIds != null && body.sessionIds.length > 0) {
        await db
          .insert(supportCaseSessions)
          .values(body.sessionIds.map((sid) => ({ caseId: newCase.id, sessionId: sid })));
      }

      // Create initial message from the description
      await db.insert(supportCaseMessages).values({
        caseId: newCase.id,
        senderType: 'operator',
        senderId: userId,
        body: body.description,
        isInternal: false,
      });

      // Notify driver if linked
      if (body.driverId != null) {
        void dispatchDriverNotification(
          client,
          'supportCase.Created',
          body.driverId,
          {
            caseNumber,
            subject: body.subject,
            category: body.category,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      void notifyCsmsEvent('supportCase.created', newCase.id);

      return newCase;
    },
  );

  // Update support case
  app.patch(
    '/support-cases/:id',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Update a support case',
        operationId: 'updateSupportCase',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(updateCaseBody),
        response: { 200: itemResponse(supportCaseItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const body = request.body as z.infer<typeof updateCaseBody>;
      const { userId } = request.user as JwtPayload;

      const [existing] = await db.select().from(supportCases).where(eq(supportCases.id, id));

      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const siteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(existing.stationId, siteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      const systemMessages: string[] = [];

      if (body.status != null && body.status !== existing.status) {
        updates['status'] = body.status;
        systemMessages.push(`Status changed from ${existing.status} to ${body.status}`);
        if (body.status === 'resolved') {
          updates['resolvedAt'] = new Date();
        }
        if (body.status === 'closed') {
          updates['closedAt'] = new Date();
        }
      }

      if (body.priority != null && body.priority !== existing.priority) {
        updates['priority'] = body.priority;
        systemMessages.push(`Priority changed from ${existing.priority} to ${body.priority}`);
      }

      if (body.category != null && body.category !== existing.category) {
        updates['category'] = body.category;
        systemMessages.push(`Category changed from ${existing.category} to ${body.category}`);
      }

      if (body.assignedTo !== undefined && body.assignedTo !== existing.assignedTo) {
        updates['assignedTo'] = body.assignedTo;
        if (body.assignedTo != null) {
          const [assignee] = await db
            .select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(eq(users.id, body.assignedTo));
          const name =
            assignee != null
              ? `${assignee.firstName ?? ''} ${assignee.lastName ?? ''}`.trim()
              : 'Unknown';
          systemMessages.push(`Assigned to ${name}`);
        } else {
          systemMessages.push('Assignment removed');
        }
      }

      // Handle session link changes
      if (body.addSessionIds != null && body.addSessionIds.length > 0) {
        await db
          .insert(supportCaseSessions)
          .values(body.addSessionIds.map((sid) => ({ caseId: id, sessionId: sid })))
          .onConflictDoNothing();
      }
      if (body.removeSessionIds != null && body.removeSessionIds.length > 0) {
        await db
          .delete(supportCaseSessions)
          .where(
            and(
              eq(supportCaseSessions.caseId, id),
              inArray(supportCaseSessions.sessionId, body.removeSessionIds),
            ),
          );
      }

      const [updated] = await db
        .update(supportCases)
        .set(updates)
        .where(eq(supportCases.id, id))
        .returning();

      // Create system messages for each change
      for (const msg of systemMessages) {
        await db.insert(supportCaseMessages).values({
          caseId: id,
          senderType: 'system',
          senderId: userId,
          body: msg,
          isInternal: false,
        });
      }

      // Notify driver on resolve
      if (body.status === 'resolved' && existing.driverId != null) {
        void dispatchDriverNotification(
          client,
          'supportCase.Resolved',
          existing.driverId,
          {
            caseNumber: existing.caseNumber,
            subject: existing.subject,
            category: existing.category,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      void notifyCsmsEvent('supportCase.updated', id);

      return updated;
    },
  );

  // Add message to support case
  app.post(
    '/support-cases/:id/messages',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Add a message to a support case',
        operationId: 'addSupportCaseMessage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(createMessageBody),
        response: { 200: itemResponse(supportCaseMessageItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const body = request.body as z.infer<typeof createMessageBody>;
      const { userId } = request.user as JwtPayload;

      const [supportCase] = await db.select().from(supportCases).where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const msgSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(supportCase.stationId, msgSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const [message] = await db
        .insert(supportCaseMessages)
        .values({
          caseId: id,
          senderType: 'operator',
          senderId: userId,
          body: body.body,
          isInternal: body.isInternal,
        })
        .returning();

      // Notify driver if not internal
      if (!body.isInternal && supportCase.driverId != null) {
        void dispatchDriverNotification(
          client,
          'supportCase.OperatorReply',
          supportCase.driverId,
          {
            caseNumber: supportCase.caseNumber,
            subject: supportCase.subject,
            category: supportCase.category,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      void notifyCsmsEvent('supportCase.newMessage', id);

      return message;
    },
  );

  // Request presigned upload URL for attachment
  app.post(
    '/support-cases/:id/messages/:messageId/attachments/upload-url',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get a presigned S3 upload URL for an attachment',
        operationId: 'getSupportCaseAttachmentUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(requestUploadUrlBody),
        response: { 200: itemResponse(uploadUrlResponse), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, messageId } = request.params as z.infer<typeof messageIdParams>;
      const body = request.body as z.infer<typeof requestUploadUrlBody>;
      const { userId } = request.user as JwtPayload;

      const [caseRow] = await db
        .select({ stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (caseRow == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const uploadSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(caseRow.stationId, uploadSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
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

  // Confirm attachment after upload
  app.post(
    '/support-cases/:id/messages/:messageId/attachments',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Confirm an attachment after uploading to S3',
        operationId: 'confirmSupportCaseAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        body: zodSchema(confirmAttachmentBody),
        response: { 200: itemResponse(attachmentItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, messageId } = request.params as z.infer<typeof messageIdParams>;
      const body = request.body as z.infer<typeof confirmAttachmentBody>;
      const { userId } = request.user as JwtPayload;

      const [caseRow] = await db
        .select({ stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (caseRow == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const confirmSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(caseRow.stationId, confirmSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
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

  // Download attachment
  app.get(
    '/support-cases/:id/messages/:messageId/attachments/:attachmentId/download-url',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get a presigned S3 download URL for an attachment',
        operationId: 'getSupportCaseAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          200: itemResponse(downloadUrlResponse),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, attachmentId } = request.params as z.infer<typeof attachmentIdParams>;
      const { userId } = request.user as JwtPayload;

      const [caseRow] = await db
        .select({ stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (caseRow == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const dlSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(caseRow.stationId, dlSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const [attachment] = await db
        .select()
        .from(supportCaseAttachments)
        .where(eq(supportCaseAttachments.id, attachmentId));

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

  // Delete attachment
  app.delete(
    '/support-cases/:id/messages/:messageId/attachments/:attachmentId',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Delete an attachment from a support case message',
        operationId: 'deleteSupportCaseAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentIdParams),
        response: {
          204: { type: 'null' as const },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, messageId, attachmentId } = request.params as z.infer<typeof attachmentIdParams>;
      const { userId } = request.user as JwtPayload;

      const [caseRow] = await db
        .select({ stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id));

      if (caseRow == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const delSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(caseRow.stationId, delSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
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
      if (s3 != null) {
        await deleteObject(s3, attachment.s3Bucket, attachment.s3Key);
      }

      await db.delete(supportCaseAttachments).where(eq(supportCaseAttachments.id, attachmentId));

      await reply.status(204).send();
    },
  );

  // Issue refund from support case
  app.post(
    '/support-cases/:id/refund',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Issue a refund for a session linked to a support case',
        operationId: 'refundSupportCaseSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(refundBody),
        response: { 200: itemResponse(paymentRecordItem), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const body = request.body as z.infer<typeof refundBody>;
      const { userId } = request.user as JwtPayload;

      const [supportCase] = await db.select().from(supportCases).where(eq(supportCases.id, id));

      if (supportCase == null) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const refundSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(supportCase.stationId, refundSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Verify the session is linked to this case
      const [linkedSession] = await db
        .select({ sessionId: supportCaseSessions.sessionId })
        .from(supportCaseSessions)
        .where(
          and(
            eq(supportCaseSessions.caseId, id),
            eq(supportCaseSessions.sessionId, body.sessionId),
          ),
        );

      if (linkedSession == null) {
        await reply.status(400).send({
          error: 'Session not linked to this case',
          code: 'SESSION_NOT_LINKED',
        });
        return;
      }

      const [record] = await db
        .select()
        .from(paymentRecords)
        .where(eq(paymentRecords.sessionId, body.sessionId));

      if (
        record == null ||
        (record.status !== 'captured' && record.status !== 'partially_refunded')
      ) {
        await reply.status(400).send({
          error: 'No captured payment to refund',
          code: 'NO_CAPTURED_PAYMENT',
        });
        return;
      }

      if (record.stripePaymentIntentId == null) {
        await reply.status(400).send({
          error: 'Payment intent missing',
          code: 'MISSING_PAYMENT_INTENT',
        });
        return;
      }

      // Resolve Stripe config for the session's station
      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .innerJoin(chargingSessions, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, body.sessionId));

      const config = await getStripeConfig(station?.siteId ?? null);
      if (config == null) {
        await reply.status(400).send({
          error: 'No Stripe configuration available',
          code: 'STRIPE_NOT_CONFIGURED',
        });
        return;
      }

      const remaining = (record.capturedAmountCents ?? 0) - record.refundedAmountCents;
      const refundAmount = body.amountCents ?? remaining;

      if (refundAmount > remaining) {
        await reply.status(400).send({
          error: `Refund amount exceeds remaining ${(remaining / 100).toFixed(2)}`,
          code: 'REFUND_EXCEEDS_REMAINING',
        });
        return;
      }

      await createRefund(config, record.stripePaymentIntentId, body.amountCents);

      const refundedTotal = record.refundedAmountCents + refundAmount;
      const isFullRefund = refundedTotal >= (record.capturedAmountCents ?? 0);

      const [updatedPayment] = await db
        .update(paymentRecords)
        .set({
          status: isFullRefund ? 'refunded' : 'partially_refunded',
          refundedAmountCents: refundedTotal,
          updatedAt: new Date(),
        })
        .where(eq(paymentRecords.id, record.id))
        .returning();

      // Look up transactionId for the system message
      const [refundedSession] = await db
        .select({ transactionId: chargingSessions.transactionId })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, body.sessionId));

      // Create system message documenting the refund
      const currencyDisplay = record.currency.toUpperCase();
      const amountDisplay = (refundAmount / 100).toFixed(2);
      const txLabel = refundedSession?.transactionId ?? body.sessionId;
      await db.insert(supportCaseMessages).values({
        caseId: id,
        senderType: 'system',
        senderId: userId,
        body: `Refund of ${amountDisplay} ${currencyDisplay} issued for session ${txLabel}`,
        isInternal: false,
      });

      // Notify driver
      if (record.driverId != null) {
        void dispatchDriverNotification(
          client,
          'payment.Refunded',
          record.driverId,
          {
            amountCents: refundAmount,
            currency: record.currency,
            transactionId: record.sessionId,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      void notifyCsmsEvent('supportCase.updated', id);

      return updatedPayment;
    },
  );

  // --- AI Assist ---

  const aiAssistBody = z.object({
    isInternalNote: z
      .boolean()
      .default(false)
      .describe('Generate an internal note instead of a customer-facing reply'),
  });

  const aiAssistResponse = z.object({ draft: z.string(), apiCallsMade: z.number() }).passthrough();

  app.post(
    '/support-cases/:id/ai-assist',
    {
      onRequest: [authorize('support:write')],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (request) => {
            const u = request.user as unknown as Record<string, unknown> | undefined;
            return (u?.['userId'] as string | undefined) ?? request.ip;
          },
        },
      },
      schema: {
        tags: ['Support Cases'],
        summary: 'Generate an AI draft reply for a support case',
        operationId: 'supportCaseAiAssist',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(aiAssistBody),
        response: { 200: itemResponse(aiAssistResponse), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const { userId } = request.user as JwtPayload;
      const { isInternalNote } = request.body as z.infer<typeof aiAssistBody>;

      // Verify case exists
      const [caseRow] = await db
        .select({ id: supportCases.id, stationId: supportCases.stationId })
        .from(supportCases)
        .where(eq(supportCases.id, id))
        .limit(1);

      if (caseRow == null) {
        await reply.status(404).send({ error: 'Case not found', code: 'CASE_NOT_FOUND' });
        return;
      }

      // Site access check
      if (caseRow.stationId != null) {
        const siteIds = await getUserSiteIds(userId);
        if (siteIds != null) {
          const [station] = await db
            .select({ siteId: chargingStations.siteId })
            .from(chargingStations)
            .where(eq(chargingStations.id, caseRow.stationId))
            .limit(1);
          if (station?.siteId != null && !siteIds.includes(station.siteId)) {
            await reply.status(404).send({ error: 'Case not found', code: 'CASE_NOT_FOUND' });
            return;
          }
        }
      }

      // Build auth header from cookie or Authorization header
      let authHeader = request.headers.authorization ?? '';
      if (authHeader === '') {
        const rawCsmsToken = request.cookies['csms_token'] ?? '';
        if (rawCsmsToken !== '') {
          const unsigned = request.unsignCookie(rawCsmsToken);
          authHeader = `Bearer ${unsigned.valid ? unsigned.value : rawCsmsToken}`;
        }
      }

      try {
        const result = await handleSupportAiAssist(app, userId, id, isInternalNote, authHeader);
        return result;
      } catch (err) {
        const error = err as Error & { code?: string };
        if (error.code === 'SUPPORT_AI_NOT_CONFIGURED') {
          await reply.status(400).send({
            error: 'Support AI is not configured',
            code: 'SUPPORT_AI_NOT_CONFIGURED',
          });
          return;
        }
        throw err;
      }
    },
  );
}
