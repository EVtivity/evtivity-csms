// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count, ilike, or, inArray, isNull } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  supportCases,
  supportCaseMessages,
  supportCaseAttachments,
  supportCaseSessions,
  supportCaseReads,
  supportCaseStatusEnum,
  supportCaseCategoryEnum,
  supportCasePriorityEnum,
  supportCaseMessageSenderEnum,
  drivers,
  users,
  chargingSessions,
  chargingStations,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { dispatchDriverNotification, formatCurrencyAmount, notificationMoney } from '@evtivity/lib';
import { AI_STREAM_PROTOCOL_VERSION } from '@evtivity/lib/ai-stream';
import { createConversation } from '../services/ai/conversation.service.js';
import { runSupportAssistTurn } from '../services/ai/engine/turn.js';
import { supportInsightContext } from '../services/ai/engine/support-insights.js';
import { requestAccessScope } from '../lib/access-scope.js';
import {
  callerAuthorization,
  claimTurnOrReply,
  limitsOrReply,
  streamTurn,
  surfaceConfigOrReply,
} from '../services/ai/engine/route-support.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import {
  addOperatorMessage,
  createSupportCase,
  deleteSupportCaseAttachment,
  markSupportCaseRead,
  recordSupportCaseAttachmentAdded,
  recordSupportCaseRefund,
  updateSupportCase,
} from '@evtivity/services/support-case.service';
import {
  DRIVER_AI_STATES,
  SUPPORT_CASE_AI_ASSIST_STATUS,
  SUPPORT_CASE_RESOLUTION_SOURCES,
  driverAiConsentRecordSchema,
} from '@evtivity/lib/driver-ai';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import type { JwtPayload } from '../plugins/auth.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { supportCaseSiteCondition } from '../lib/support-case-scope.js';
import {
  foreignCaseSessionRefs,
  sessionIdsInSites,
  messageReferencesForeignSession,
} from '../lib/support-case-redaction.js';
import { manageableUsersCondition } from '../lib/user-management-scope.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const supportCaseListItem = z
  .object({
    id: z.string().describe('Support case ID'),
    caseNumber: z.string().describe('Human-readable case number, e.g. CASE-00042'),
    subject: z.string().max(255).describe('Case subject line'),
    status: z
      .enum(supportCaseStatusEnum.enumValues)
      .describe(
        'Case status (open, in_progress, waiting_on_driver, resolved, closed; ai_assist while the driver AI handles it)',
      ),
    category: z.enum(supportCaseCategoryEnum.enumValues).describe('Case category'),
    priority: z.enum(supportCasePriorityEnum.enumValues).describe('Case priority level'),
    createdByDriver: z.boolean().describe('True if the case was created by the driver'),
    aiState: z
      .enum(DRIVER_AI_STATES)
      .nullable()
      .describe('Driver AI step state; null when the case had no AI step'),
    resolutionSource: z
      .enum(SUPPORT_CASE_RESOLUTION_SOURCES)
      .nullable()
      .describe('Who resolved the case (operator or ai); null while it is not resolved'),
    driverName: z.string().nullable().describe('Full name of the linked driver'),
    assignedToName: z.string().nullable().describe('Full name of the assigned operator'),
    assignedTo: z.string().nullable().describe('Operator user ID assigned to handle this case'),
    driverId: z.string().nullable().describe('Driver ID linked to this case'),
    isRead: z.boolean().describe('True if the current operator has read the latest messages'),
    createdAt: z.coerce.date().describe('Timestamp when the case was created'),
  })
  .passthrough();

const supportCaseItem = z
  .object({
    id: z.string().describe('Support case ID'),
    caseNumber: z.string().describe('Human-readable case number, e.g. CASE-00042'),
    subject: z.string().max(255).describe('Case subject line'),
    description: z.string().describe('Initial case description'),
    status: z
      .enum(supportCaseStatusEnum.enumValues)
      .describe('Case status (open, in_progress, waiting_on_driver, resolved, closed)'),
    category: z.enum(supportCaseCategoryEnum.enumValues).describe('Case category'),
    priority: z.enum(supportCasePriorityEnum.enumValues).describe('Case priority level'),
    driverId: z.string().nullable().describe('Driver ID linked to this case'),
    stationId: z.string().nullable().describe('Charging station ID related to this case'),
    assignedTo: z.string().nullable().describe('Operator user assigned to handle this case'),
    createdByDriver: z.boolean().describe('True if the case was created by the driver'),
    createdAt: z.coerce.date().describe('Timestamp when the case was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the case was last updated'),
  })
  .passthrough();

const attachmentItem = z
  .object({
    id: z.number().int().describe('Attachment ID'),
    messageId: z.number().int().describe('Message ID this attachment belongs to'),
    fileName: z
      .string()
      .max(255)
      .describe('Sanitized file name (a re-encoded image gets the extension of its new type)'),
    fileSize: z.number().int().min(0).describe('Size of the stored (sanitized) file in bytes'),
    contentType: z
      .string()
      .max(100)
      .describe('Content type sniffed from the file (images are stored as JPEG or PNG)'),
    createdAt: z.coerce.date().describe('Timestamp when the attachment was uploaded'),
  })
  .passthrough();

const supportCaseMessageItem = z
  .object({
    id: z.number().int().describe('Message ID'),
    senderType: z
      .enum(supportCaseMessageSenderEnum.enumValues)
      .describe('Message sender (driver, operator, system, assistant: the automatic answer)'),
    senderId: z
      .string()
      .nullable()
      .describe('User or driver ID of the sender, null for system messages'),
    body: z.string().describe('Message body'),
    isInternal: z.boolean().describe('True for operator-only internal notes'),
    createdAt: z.coerce.date().describe('Timestamp when the message was created'),
    attachments: z.array(attachmentItem).optional().describe('Attachments on this message'),
  })
  .passthrough();

const sessionRef = z
  .object({
    id: z.string().describe('Charging session ID'),
    transactionId: z.string().nullable().describe('OCPP transaction ID for the session'),
  })
  .passthrough();

const supportCaseDetail = supportCaseItem
  .extend({
    driverName: z.string().nullable().describe('Full name of the linked driver'),
    driverEmail: z.string().nullable().describe('Email address of the linked driver'),
    stationName: z.string().nullable().describe('Station ID/name of the related charging station'),
    assignedToName: z.string().nullable().describe('Full name of the assigned operator'),
    resolvedAt: z.coerce.date().nullable().describe('Timestamp when the case was resolved'),
    closedAt: z.coerce.date().nullable().describe('Timestamp when the case was closed'),
    sessions: z.array(sessionRef).describe('Charging sessions linked to this case'),
    messages: z
      .array(supportCaseMessageItem)
      .describe(
        'Messages on this case in chronological order; the automatic answer has senderType assistant',
      ),
    aiConsent: driverAiConsentRecordSchema
      .nullable()
      .describe('The driver consent to the AI analysis; null when the driver was not asked'),
    aiState: z
      .enum(DRIVER_AI_STATES)
      .nullable()
      .describe('Driver AI step state; null when the case had no AI step'),
    aiStateReason: z.string().nullable().describe('Reason of the AI step state, when any'),
    aiAnsweredAt: z.coerce.date().nullable().describe('When the automatic answer was stored'),
    aiFeedbackAt: z.coerce
      .date()
      .nullable()
      .describe('When the driver answered the feedback question'),
    resolutionSource: z
      .enum(SUPPORT_CASE_RESOLUTION_SOURCES)
      .nullable()
      .describe('Who resolved the case (operator or ai); null while it is not resolved'),
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
    downloadUrl: z.string().describe('Presigned S3 GET URL for downloading the attachment'),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.string().describe('Payment record ID'),
    sessionId: z.string().nullable().describe('Charging session ID linked to this payment'),
    driverId: z.string().nullable().describe('Driver ID linked to this payment'),
    status: z.string().describe('Payment lifecycle state'),
    currency: z.string().describe('ISO 4217 currency code'),
    capturedAmountCents: z
      .number()
      .nullable()
      .describe('Amount captured from the pre-authorization in cents'),
    refundedAmountCents: z.number().int().min(0).describe('Total amount refunded in cents'),
    createdAt: z.coerce.date().describe('Timestamp when the payment record was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the payment record was last updated'),
  })
  .passthrough();

const supportRefundItem = paymentRecordItem
  .extend({
    refundStatus: z
      .enum(['succeeded', 'pending'])
      .describe(
        'succeeded: the refund is done. pending: an asynchronous provider (Adyen) accepted it and confirms it by webhook; the driver is notified then.',
      ),
  })
  .passthrough();
import { getS3Config, deleteObject } from '../services/s3.service.js';
import {
  confirmSupportAttachment,
  requestSupportAttachmentUpload,
  supportAttachmentDownloadUrl,
} from '../services/ai/attachments/support-attachments.js';
import { refundPaymentRecord } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';

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
    .enum(['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed', 'ai_assist'])
    .optional()
    .describe(
      'Filter by case status. Cases the driver AI still handles (ai_assist) are listed only with status ai_assist or an aiState filter',
    ),
  aiState: z
    .enum(DRIVER_AI_STATES)
    .optional()
    .describe('Filter by driver AI step state (includes ai_assist cases)'),
  resolutionSource: z
    .enum(SUPPORT_CASE_RESOLUTION_SOURCES)
    .optional()
    .describe('Filter by who resolved the case (operator or ai)'),
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
  body: z.string().min(1).max(10000),
  isInternal: z.boolean().default(false).describe('If true, message is only visible to operators'),
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

const refundBody = z.object({
  sessionId: ID_PARAMS.sessionId.describe(
    'Charging session ID (ses_ prefixed nanoid) to refund. Must be linked to this case via support_case_sessions.',
  ),
  amountCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Partial refund amount in cents. Omit for full refund.'),
});

// "Is this case unread for `userId`?" -- no read row at all, OR a driver
// message arrived after the last read timestamp. Shared by the list endpoint
// (as a CASE column) and the unread-count endpoint (as a WHERE condition).
function unreadCondition(userId: string) {
  return sql`(
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
  )`;
}

/** True when the support case is visible to the user (see supportCaseSiteCondition). */
async function isCaseAccessible(caseId: string, siteIds: string[] | null): Promise<boolean> {
  if (siteIds == null) return true;
  const [row] = await db
    .select({ id: supportCases.id })
    .from(supportCases)
    .where(and(eq(supportCases.id, caseId), supportCaseSiteCondition(siteIds)));
  return row != null;
}

/** True when the station is in one of the user's sites (unsited is out of scope). */
async function isStationInScope(stationId: string, siteIds: string[] | null): Promise<boolean> {
  if (siteIds == null) return true;
  if (siteIds.length === 0) return false;
  const [station] = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(and(eq(chargingStations.id, stationId), inArray(chargingStations.siteId, siteIds)));
  return station != null;
}

/**
 * True when every session exists and ran at a station in the user's sites.
 * Used before linking or unlinking sessions on a case, so an operator can
 * neither attach a foreign session (and refund it through the case) nor
 * learn which foreign sessions a case holds.
 */
async function sessionsInScope(sessionIds: string[], siteIds: string[] | null): Promise<boolean> {
  if (siteIds == null) return true;
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return true;
  if (siteIds.length === 0) return false;
  const rows = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(and(inArray(chargingSessions.id, unique), inArray(chargingSessions.siteId, siteIds)));
  return rows.length === unique.length;
}

/**
 * True when every session belongs to the case's driver, or the case has no
 * driver. The driver portal lists a case's linked sessions, so a session of
 * another driver must never be linked to a driver's case.
 */
async function sessionsOfCaseDriver(
  sessionIds: string[],
  caseDriverId: string | null,
): Promise<boolean> {
  if (caseDriverId == null) return true;
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return true;
  const rows = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(and(inArray(chargingSessions.id, unique), eq(chargingSessions.driverId, caseDriverId)));
  return rows.length === unique.length;
}

const SESSION_OF_OTHER_DRIVER = {
  error: 'A linked session must belong to the case driver',
  code: 'VALIDATION_ERROR',
};

/**
 * The assignee's name when the user exists and the actor can see it in the
 * user list (manageableUsersCondition), else undefined: a site-restricted
 * operator assigns a case only to users of its own sites.
 */
async function findVisibleAssignee(
  assigneeId: string,
  siteIds: string[] | null,
): Promise<{ firstName: string | null; lastName: string | null } | undefined> {
  const [row] = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(and(eq(users.id, assigneeId), manageableUsersCondition(siteIds)));
  return row;
}

const USER_NOT_FOUND = { error: 'User not found', code: 'USER_NOT_FOUND' };

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
        conditions.push(supportCaseSiteCondition(accessibleSiteIds));
      }
      if (query.status != null) {
        conditions.push(eq(supportCases.status, query.status));
      } else if (query.aiState == null) {
        // Cases the driver AI still handles are not in the default list: no operator needs to act yet.
        conditions.push(sql`${supportCases.status} <> ${SUPPORT_CASE_AI_ASSIST_STATUS}`);
      }
      if (query.aiState != null) {
        conditions.push(eq(supportCases.aiState, query.aiState));
      }
      if (query.resolutionSource != null) {
        conditions.push(eq(supportCases.resolutionSource, query.resolutionSource));
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
            aiState: supportCases.aiState,
            resolutionSource: supportCases.resolutionSource,
            driverName: sql<
              string | null
            >`CASE WHEN ${drivers.id} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
            assignedToName: sql<
              string | null
            >`CASE WHEN ${users.id} IS NOT NULL THEN ${users.firstName} || ' ' || ${users.lastName} ELSE NULL END`,
            assignedTo: supportCases.assignedTo,
            driverId: supportCases.driverId,
            isRead: sql<boolean>`NOT ${unreadCondition(userId)}`,
            createdAt: supportCases.createdAt,
          })
          .from(supportCases)
          .leftJoin(drivers, eq(supportCases.driverId, drivers.id))
          .leftJoin(users, eq(supportCases.assignedTo, users.id))
          .where(where)
          .orderBy(desc(supportCases.createdAt), desc(supportCases.id))
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
          200: zodSchema(
            z
              .object({
                count: z
                  .number()
                  .describe('Number of unread support cases assigned to the current operator'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;

      const accessibleSiteIds = await getUserSiteIds(userId);

      const conditions = [
        eq(supportCases.assignedTo, userId),
        // ai_assist: the driver AI still handles it, so no operator needs to act yet.
        sql`${supportCases.status} NOT IN ('resolved', 'closed', 'ai_assist')`,
        unreadCondition(userId),
      ];

      if (accessibleSiteIds != null) {
        conditions.push(supportCaseSiteCondition(accessibleSiteIds));
      }

      const result = await db
        .select({ count: count() })
        .from(supportCases)
        .where(and(...conditions));

      return { count: result[0]?.count ?? 0 };
    },
  );

  // Open, unassigned support case count: the Support Cases nav badge.
  app.get(
    '/support-cases/unassigned-count',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get the open, unassigned support case count in the current operator sites',
        operationId: 'getUnassignedSupportCaseCount',
        security: [{ bearerAuth: [] }],
        response: {
          200: zodSchema(
            z
              .object({
                count: z
                  .number()
                  .describe(
                    'Number of open support cases with no assignee in the sites the current operator can access',
                  ),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;

      const accessibleSiteIds = await getUserSiteIds(userId);

      const conditions = [
        isNull(supportCases.assignedTo),
        // ai_assist: the driver AI still handles it, so no operator needs to act yet.
        sql`${supportCases.status} NOT IN ('resolved', 'closed', 'ai_assist')`,
      ];

      if (accessibleSiteIds != null) {
        conditions.push(supportCaseSiteCondition(accessibleSiteIds));
      }

      const result = await db
        .select({ count: count() })
        .from(supportCases)
        .where(and(...conditions));

      return { count: result[0]?.count ?? 0 };
    },
  );

  // Whether attachments can be uploaded. Support users need this without the
  // settings permission that GET /v1/settings/s3/status requires.
  app.get(
    '/support-cases/attachment-storage',
    {
      onRequest: [authorize('support:read')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Get whether support case attachment storage is configured',
        operationId: 'getSupportAttachmentStorage',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                configured: z
                  .boolean()
                  .describe(
                    'Whether S3 storage is configured, so attachments can be uploaded to support case messages',
                  ),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      try {
        return { configured: (await getS3Config()) != null };
      } catch (err) {
        request.log.warn({ err }, 'S3 configuration could not be read');
        return { configured: false };
      }
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
        response: {
          200: itemResponse(supportCaseDetail),
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
        },
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
          aiConsentDecision: supportCases.aiConsent,
          aiConsentAt: supportCases.aiConsentAt,
          aiConsentLanguage: supportCases.aiConsentLanguage,
          aiConsentNoticeVersion: supportCases.aiConsentNoticeVersion,
          aiState: supportCases.aiState,
          aiStateReason: supportCases.aiStateReason,
          aiAnsweredAt: supportCases.aiAnsweredAt,
          aiFeedbackAt: supportCases.aiFeedbackAt,
          resolutionSource: supportCases.resolutionSource,
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
      if (!(await isCaseAccessible(id, siteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Sessions and messages are independent — fan them in parallel so
      // the detail GET is bounded by the slower query, not the sum.
      const [sessions, allMessages, foreignRefs] = await Promise.all([
        db
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
          .where(
            and(
              eq(supportCaseSessions.caseId, id),
              // A site-restricted operator sees only the linked sessions of
              // its own sites (unsited stations are out of scope).
              siteIds != null ? inArray(chargingStations.siteId, siteIds) : undefined,
            ),
          ),
        db
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
          .orderBy(supportCaseMessages.createdAt),
        foreignCaseSessionRefs(id, siteIds),
      ]);
      // A site-restricted operator does not see the messages that name a
      // session of another site (refund messages, owner decision 2026-10-09).
      const messages = allMessages.filter((m) => !messageReferencesForeignSession(m, foreignRefs));

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

      const {
        aiConsentDecision,
        aiConsentAt,
        aiConsentLanguage,
        aiConsentNoticeVersion,
        ...caseFields
      } = supportCase;
      const aiConsent =
        (aiConsentDecision === 'granted' || aiConsentDecision === 'declined') &&
        aiConsentAt != null &&
        aiConsentLanguage != null &&
        aiConsentNoticeVersion != null
          ? {
              decision: aiConsentDecision,
              at: aiConsentAt.toISOString(),
              language: aiConsentLanguage,
              noticeVersion: aiConsentNoticeVersion,
            }
          : null;
      return { ...caseFields, aiConsent, sessions, messages: messagesWithAttachments };
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
        response: {
          200: successResponse,
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
        },
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
      if (!(await isCaseAccessible(id, readSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      await markSupportCaseRead(userId, id);

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
        response: {
          200: itemResponse(supportCaseItem),
          400: errorWith('A linked session belongs to another driver', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.SESSION_NOT_FOUND,
            ERROR_CODES.USER_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createCaseBody>;
      const { userId } = request.user as JwtPayload;
      const createSiteIds = await getUserSiteIds(userId);

      if (body.stationId != null) {
        if (!(await isStationInScope(body.stationId, createSiteIds))) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }

      // Validate site access on every sessionId before linking. Without this
      // an operator could link sessions from a station they have no access
      // to, then use the refund endpoint (which only checks case access) to
      // refund cross-site payments.
      if (body.sessionIds != null && !(await sessionsInScope(body.sessionIds, createSiteIds))) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      if (
        body.sessionIds != null &&
        !(await sessionsOfCaseDriver(body.sessionIds, body.driverId ?? null))
      ) {
        await reply.status(400).send(SESSION_OF_OTHER_DRIVER);
        return;
      }

      if (
        body.assignedTo != null &&
        (await findVisibleAssignee(body.assignedTo, createSiteIds)) == null
      ) {
        await reply.status(404).send(USER_NOT_FOUND);
        return;
      }

      return createSupportCase({
        subject: body.subject,
        description: body.description,
        category: body.category,
        priority: body.priority,
        driverId: body.driverId ?? null,
        stationId: body.stationId ?? null,
        assignedTo: body.assignedTo ?? null,
        sessionIds: body.sessionIds ?? [],
        openedBy: { type: 'operator', userId },
        actor: getAuditActor(request),
        log: request.log,
      });
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
        response: {
          200: itemResponse(supportCaseItem),
          400: errorWith('A linked session belongs to another driver', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.SESSION_NOT_FOUND,
            ERROR_CODES.USER_NOT_FOUND,
          ]),
        },
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
      if (!(await isCaseAccessible(id, siteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Validate before any write: the assignee must be a user the actor can
      // see, and every linked or unlinked session must be in its sites.
      const assignee =
        body.assignedTo != null && body.assignedTo !== existing.assignedTo
          ? await findVisibleAssignee(body.assignedTo, siteIds)
          : undefined;
      if (body.assignedTo != null && body.assignedTo !== existing.assignedTo && assignee == null) {
        await reply.status(404).send(USER_NOT_FOUND);
        return;
      }

      // Validate site access on every added sessionId -- without it an
      // operator could link sessions from a station they have no access to,
      // then refund cross-site via the case's refund endpoint. Removed ids are
      // checked the same way, so a restricted operator cannot unlink (or probe
      // for) a session of another site.
      if (
        (body.addSessionIds != null && !(await sessionsInScope(body.addSessionIds, siteIds))) ||
        (body.removeSessionIds != null && !(await sessionsInScope(body.removeSessionIds, siteIds)))
      ) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      if (
        body.addSessionIds != null &&
        !(await sessionsOfCaseDriver(body.addSessionIds, existing.driverId))
      ) {
        await reply.status(400).send(SESSION_OF_OTHER_DRIVER);
        return;
      }

      return updateSupportCase({
        existing,
        status: body.status,
        priority: body.priority,
        category: body.category,
        assignedTo: body.assignedTo,
        assigneeName:
          assignee != null
            ? `${assignee.firstName ?? ''} ${assignee.lastName ?? ''}`.trim()
            : undefined,
        addSessionIds: body.addSessionIds,
        removeSessionIds: body.removeSessionIds,
        userId,
        actor: getAuditActor(request),
        log: request.log,
      });
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
        response: {
          200: itemResponse(supportCaseMessageItem),
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
        },
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
      if (!(await isCaseAccessible(id, msgSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      return addOperatorMessage({
        supportCase,
        userId,
        body: body.body,
        isInternal: body.isInternal,
        actor: getAuditActor(request),
        log: request.log,
      });
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
        description:
          'Returns a presigned S3 POST into quarantine. The type must be allowlisted and the size within ai.attachments.maxBytes; S3 enforces both. Confirm the upload afterwards.',
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
          404: errorWith('Message not found', [ERROR_CODES.MESSAGE_NOT_FOUND]),
        },
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
      if (!(await isCaseAccessible(id, uploadSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const [message] = await db
        .select({
          id: supportCaseMessages.id,
          senderType: supportCaseMessages.senderType,
          body: supportCaseMessages.body,
        })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      // A message naming another site's session is hidden from a
      // site-restricted operator (case detail), so its attachments are too.
      if (
        message == null ||
        messageReferencesForeignSession(message, await foreignCaseSessionRefs(id, uploadSiteIds))
      ) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      return requestSupportAttachmentUpload(id, messageId, body);
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
        description:
          'Reads the uploaded file, checks its bytes against the declared type, re-encodes images (metadata stripped, long edge at most 2576 px), checks PDFs (not encrypted, page limit) and text (UTF-8, cut to 2 MB), stores the clean file and records it on the message. Confirming the same key again returns the stored attachment.',
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
          404: errorWith('Message not found', [ERROR_CODES.MESSAGE_NOT_FOUND]),
        },
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
      if (!(await isCaseAccessible(id, confirmSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      const [message] = await db
        .select({
          id: supportCaseMessages.id,
          senderType: supportCaseMessages.senderType,
          body: supportCaseMessages.body,
        })
        .from(supportCaseMessages)
        .where(and(eq(supportCaseMessages.id, messageId), eq(supportCaseMessages.caseId, id)));

      // A message naming another site's session is hidden from a
      // site-restricted operator (case detail), so its attachments are too.
      if (
        message == null ||
        messageReferencesForeignSession(message, await foreignCaseSessionRefs(id, confirmSiteIds))
      ) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      // The key must be one issued for THIS case and message (checked by the
      // service), so an operator cannot register another case's object.
      const { attachment, created } = await confirmSupportAttachment(
        id,
        messageId,
        body.s3Key,
        request.log,
      );

      if (created) {
        await recordSupportCaseAttachmentAdded({
          caseId: id,
          messageId,
          attachment,
          actor: getAuditActor(request),
          log: request.log,
        });
      }

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
          400: errorWith('S3 not configured', [ERROR_CODES.STORAGE_NOT_CONFIGURED]),
          404: errorWith('Attachment not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.ATTACHMENT_NOT_FOUND,
          ]),
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

      const dlSiteIds = await getUserSiteIds(userId);
      if (!(await isCaseAccessible(id, dlSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Verify the attachment belongs to the message AND the message belongs
      // to this case. Without this join an operator with access to any case
      // could download any attachment by guessing its id.
      const [attachment] = await db
        .select({
          s3Key: supportCaseAttachments.s3Key,
          s3Bucket: supportCaseAttachments.s3Bucket,
          fileName: supportCaseAttachments.fileName,
          contentType: supportCaseAttachments.contentType,
          senderType: supportCaseMessages.senderType,
          body: supportCaseMessages.body,
        })
        .from(supportCaseAttachments)
        .innerJoin(
          supportCaseMessages,
          eq(supportCaseAttachments.messageId, supportCaseMessages.id),
        )
        .where(
          and(
            eq(supportCaseAttachments.id, attachmentId),
            eq(supportCaseAttachments.messageId, messageId),
            eq(supportCaseMessages.caseId, id),
          ),
        );

      if (
        attachment == null ||
        messageReferencesForeignSession(attachment, await foreignCaseSessionRefs(id, dlSiteIds))
      ) {
        await reply
          .status(404)
          .send({ error: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND' });
        return;
      }

      return { downloadUrl: await supportAttachmentDownloadUrl(attachment) };
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
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Attachment not found', [
            ERROR_CODES.SUPPORT_CASE_NOT_FOUND,
            ERROR_CODES.ATTACHMENT_NOT_FOUND,
          ]),
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
      if (!(await isCaseAccessible(id, delSiteIds))) {
        await reply
          .status(404)
          .send({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
        return;
      }

      // Verify the attachment belongs to a message belonging to this case.
      // Without the join an operator with access to one case could delete
      // attachments from another case by knowing the attachmentId+messageId.
      const [attachment] = await db
        .select({
          s3Key: supportCaseAttachments.s3Key,
          s3Bucket: supportCaseAttachments.s3Bucket,
          senderType: supportCaseMessages.senderType,
          body: supportCaseMessages.body,
        })
        .from(supportCaseAttachments)
        .innerJoin(
          supportCaseMessages,
          eq(supportCaseAttachments.messageId, supportCaseMessages.id),
        )
        .where(
          and(
            eq(supportCaseAttachments.id, attachmentId),
            eq(supportCaseAttachments.messageId, messageId),
            eq(supportCaseMessages.caseId, id),
          ),
        );

      if (
        attachment == null ||
        messageReferencesForeignSession(attachment, await foreignCaseSessionRefs(id, delSiteIds))
      ) {
        await reply
          .status(404)
          .send({ error: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 != null) {
        await deleteObject(s3, attachment.s3Bucket, attachment.s3Key);
      }

      await deleteSupportCaseAttachment({
        caseId: id,
        messageId,
        attachmentId,
        actor: getAuditActor(request),
        log: request.log,
      });

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
        description:
          'Refunds the payment of the supplied sessionId through the provider it was made with; the session must be linked to this case via the support_case_sessions junction table. Supports partial refunds via amountCents. Allowed against captured or partially_refunded payments; 409 PAYMENT_OPERATION_PENDING while the provider has not confirmed the capture. refundStatus is pending when an asynchronous provider (Adyen) confirms the refund later by webhook. Posts an audit message to the case timeline on success.',
        operationId: 'refundSupportCaseSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(refundBody),
        response: {
          200: itemResponse(supportRefundItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MISSING_PAYMENT_INTENT,
            ERROR_CODES.NO_CAPTURED_PAYMENT,
            ERROR_CODES.REFUND_EXCEEDS_REMAINING,
            ERROR_CODES.SESSION_NOT_LINKED,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Support case not found', [ERROR_CODES.SUPPORT_CASE_NOT_FOUND]),
          409: errorWith(
            'Refund reaches an unrecorded top-up, or the capture is not confirmed yet',
            [ERROR_CODES.REFUND_TOP_UP_UNKNOWN, ERROR_CODES.PAYMENT_OPERATION_PENDING],
          ),
        },
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
      if (!(await isCaseAccessible(id, refundSiteIds))) {
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

      // Fetch the session's station siteId and transactionId once — used
      // downstream for the site-access check, the Stripe per-site config
      // lookup, and the system message label.
      const [sessionStation] = await db
        .select({
          siteId: chargingStations.siteId,
          transactionId: chargingSessions.transactionId,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, body.sessionId));

      // Defense in depth: verify the session's station is in the operator's
      // accessible sites. The link-time validation in create/PATCH should
      // have caught this already, but historical rows (linked before the
      // validation was added) could still expose cross-site refunds.
      if (sessionStation != null && !siteInScope(refundSiteIds, sessionStation.siteId)) {
        await reply.status(400).send({
          error: 'Session not linked to this case',
          code: 'SESSION_NOT_LINKED',
        });
        return;
      }

      // The same refund path as the operator route: the record is locked,
      // and the key refund_<paymentId>_<refundedSoFar>_<amount>_<ledger> makes a
      // retried request reuse the provider refund instead of refunding twice
      // (P7), while a later partial refund gets a new key.
      const outcome = await refundPaymentRecord(
        {
          sessionId: body.sessionId,
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
        },
        paymentContext(request.log, getAuditActor(request)),
      );
      switch (outcome.status) {
        // not_found answers only a fee target.
        case 'not_found':
        case 'no_captured_payment':
          await reply.status(400).send({
            error: 'No captured payment to refund',
            code: 'NO_CAPTURED_PAYMENT',
          });
          return;
        case 'missing_payment_id':
          await reply.status(400).send({
            error: 'Payment intent missing',
            code: 'MISSING_PAYMENT_INTENT',
          });
          return;
        case 'not_configured':
          await reply.status(400).send({
            error: 'No payment provider configured',
            code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
          });
          return;
        case 'nothing_refundable':
          await reply.status(400).send({
            error: 'No remaining refundable amount on this payment',
            code: 'REFUND_EXCEEDS_REMAINING',
          });
          return;
        case 'exceeds_remaining':
          await reply.status(400).send({
            error: `Refund amount exceeds remaining ${formatCurrencyAmount(outcome.remainingCents, outcome.currency)}`,
            code: 'REFUND_EXCEEDS_REMAINING',
          });
          return;
        case 'top_up_unknown':
          // A retry top-up made before v0.1.37 has no stored payment id, so
          // only the charges EVtivity knows can be refunded here.
          await reply.status(409).send({
            error: `This payment includes a top-up charge of ${formatCurrencyAmount(outcome.unlistedCents, outcome.currency)} with no recorded payment id. Refund up to ${formatCurrencyAmount(outcome.refundableCents, outcome.currency)} here and refund the top-up in the payment provider's dashboard.`,
            code: 'REFUND_TOP_UP_UNKNOWN',
          });
          return;
        case 'operation_pending':
          // O3: a refund of a capture the provider may still fail is refused.
          await reply.status(409).send({
            error:
              "The payment has an operation waiting for the provider's confirmation. Try again later.",
            code: 'PAYMENT_OPERATION_PENDING',
          });
          return;
        case 'refunded':
          break;
      }
      const updatedPayment = outcome.record;
      const record = outcome.record;
      const pending = outcome.refundStatus === 'pending';
      const refundAmount = outcome.refundedNowCents + outcome.pendingCents;

      // Create system message documenting the refund. Best-effort: don't
      // 500 the request after the refund already cleared the provider and
      // the payment record was updated.
      const amountDisplay = formatCurrencyAmount(refundAmount, record.currency);
      const txLabel = sessionStation?.transactionId ?? body.sessionId;
      // Notify driver (a pending refund notifies when the provider confirms it)
      if (record.driverId != null && !pending) {
        void dispatchDriverNotification(
          client,
          'payment.Refunded',
          record.driverId,
          {
            amountCents: refundAmount,
            amountFormatted: notificationMoney(refundAmount, record.currency),
            currency: record.currency,
            transactionId: record.sessionId,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      await recordSupportCaseRefund({
        supportCase,
        userId,
        message: pending
          ? `Refund of ${amountDisplay} requested for session ${txLabel}; awaiting the payment provider's confirmation`
          : `Refund of ${amountDisplay} issued for session ${txLabel}`,
        audit: { sessionId: body.sessionId, amountCents: refundAmount, currency: record.currency },
        actor: getAuditActor(request),
        log: request.log,
      });

      return { ...updatedPayment, refundStatus: outcome.refundStatus };
    },
  );

  // --- AI Assist ---

  const aiAssistBody = z.object({
    isInternalNote: z
      .boolean()
      .default(false)
      .describe('Generate an internal note instead of a customer-facing reply'),
  });

  const aiAssistStream = `Server-sent events (protocol version ${String(AI_STREAM_PROTOCOL_VERSION)}): message_start, text_delta (the draft), tool_step, usage, error, done. Parse with readAiStream from @evtivity/lib/ai-stream.`;

  app.post(
    '/support-cases/:id/ai-assist',
    {
      onRequest: [authorize('support:write')],
      schema: {
        tags: ['Support Cases'],
        summary: 'Stream an AI draft reply for a support case',
        description:
          "Streams a draft reply (text/event-stream). The support AI reads only the case's own data: the case, its linked sessions, its station and its driver, with the ids pinned by the server, so text in the case cannot pull in another case's data. It has no write tools. The draft is for operator review and is not sent or saved as a message. Errors before the stream opens are JSON.",
        operationId: 'supportCaseAiAssist',
        security: [{ bearerAuth: [] }],
        params: zodSchema(caseIdParams),
        body: zodSchema(aiAssistBody),
        response: {
          200: {
            description: aiAssistStream,
            content: {
              'text/event-stream': { schema: { type: 'string', description: aiAssistStream } },
            },
          },
          400: errorWith('Support ai not configured', [
            ERROR_CODES.SUPPORT_AI_NOT_CONFIGURED,
            ERROR_CODES.AI_BASE_URL_INVALID,
          ]),
          404: errorWith('Case not found', [ERROR_CODES.CASE_NOT_FOUND]),
          429: errorWith('AI limit reached', [
            ERROR_CODES.AI_RATE_LIMITED,
            ERROR_CODES.AI_BUDGET_EXCEEDED,
            ERROR_CODES.AI_MONTHLY_BUDGET_EXCEEDED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof caseIdParams>;
      const { userId } = request.user as JwtPayload;
      const { isInternalNote } = request.body as z.infer<typeof aiAssistBody>;

      const [caseRow] = await db
        .select({
          id: supportCases.id,
          caseNumber: supportCases.caseNumber,
          stationId: supportCases.stationId,
          driverId: supportCases.driverId,
          siteId: chargingStations.siteId,
          driverLanguage: drivers.language,
        })
        .from(supportCases)
        .leftJoin(chargingStations, eq(chargingStations.id, supportCases.stationId))
        .leftJoin(drivers, eq(drivers.id, supportCases.driverId))
        .where(eq(supportCases.id, id))
        .limit(1);
      const siteIds = await getUserSiteIds(userId);
      if (caseRow == null || !(await isCaseAccessible(id, siteIds))) {
        return reply.status(404).send({ error: 'Case not found', code: 'CASE_NOT_FOUND' });
      }

      const config = await surfaceConfigOrReply('support', userId, reply);
      if (config === null) return reply;
      const limits = await limitsOrReply('support', userId, caseRow.siteId ?? null, reply);
      if (limits === null) return reply;

      const sessionRows = await db
        .select({ sessionId: supportCaseSessions.sessionId })
        .from(supportCaseSessions)
        .where(eq(supportCaseSessions.caseId, id));
      // A site-restricted operator's assistant sees only the linked sessions
      // of its sites, like the case detail (features/support-cases.md, Site scope).
      const linkedSessionIds = sessionRows.map((r) => r.sessionId);
      const sessionIds =
        siteIds == null
          ? linkedSessionIds
          : [...(await sessionIdsInSites(linkedSessionIds, siteIds))];
      // Fresh automatic insights save the draft tool calls (fail-open), only
      // for an operator who may read insights: the draft would show them.
      let insightContext: string | null = null;
      try {
        if (await requestHasPermission(request, 'aiInsights:read')) {
          insightContext = await supportInsightContext(
            { stationId: caseRow.stationId, sessionIds },
            siteIds,
          );
        }
      } catch (err) {
        request.log.warn({ err, caseId: id }, 'Support draft insights could not be read');
      }
      const actor = getAuditActor(request);
      const conversation = await createConversation(
        {
          userId,
          surface: 'support',
          supportCaseId: id,
          provider: config.provider,
          model: config.model,
          title: `${caseRow.caseNumber} ${isInternalNote ? 'internal note' : 'reply'}`,
        },
        actor,
        request.log,
      );
      const accessScope = await requestAccessScope(request, userId);
      if (!(await claimTurnOrReply(conversation.id, reply))) return reply;
      await streamTurn(request, reply, conversation.id, config, (stream) =>
        runSupportAssistTurn({
          ctx: {
            app,
            userId,
            authorization: callerAuthorization(request),
            accessScope,
            isApiKey: (request.user as JwtPayload).isApiKey === true,
            hasPermission: (permission: string) => requestHasPermission(request, permission),
            actor,
            log: request.log,
          },
          conversation,
          config,
          stream,
          caseContext: {
            caseId: id,
            stationId: caseRow.stationId,
            driverId: caseRow.driverId,
            sessionIds,
          },
          siteId: caseRow.siteId ?? null,
          caseNumber: caseRow.caseNumber,
          driverLanguage: caseRow.driverLanguage,
          isInternalNote,
          maxToolCalls: limits.maxToolCallsPerTurn,
          insightContext,
        }),
      );
      return reply;
    },
  );
}
