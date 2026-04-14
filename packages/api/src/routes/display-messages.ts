// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { displayMessages, chargingStations } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { getUserSiteIds, checkStationSiteAccess } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const displayMessageItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    ocppMessageId: z.number(),
    priority: z.string(),
    status: z.string(),
    format: z.string(),
    content: z.string(),
    language: z.string().nullable(),
    state: z.string().nullable(),
    startDateTime: z.coerce.date().nullable(),
    endDateTime: z.coerce.date().nullable(),
    transactionId: z.string().nullable(),
    evseId: z.number().nullable(),
    messageExtra: z.array(z.record(z.unknown())).nullable(),
    ocppResponse: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const clearMessageResponse = z.object({ status: z.literal('cleared') }).passthrough();

const refreshMessageResponse = z.object({ status: z.string() }).passthrough();

const stationIdParams = z.object({
  stationId: ID_PARAMS.stationId.describe('Charging station ID'),
});
const messageIdParams = z.object({
  stationId: ID_PARAMS.stationId.describe('Charging station ID'),
  id: z.coerce.number().int().min(1).describe('Display message ID'),
});

const listMessagesQuery = paginationQuery.extend({
  status: z
    .enum(['pending', 'accepted', 'rejected', 'cleared', 'expired'])
    .optional()
    .describe('Filter by message status'),
});

const createMessageBody = z.object({
  priority: z
    .enum(['AlwaysFront', 'InFront', 'NormalCycle'])
    .describe('OCPP display priority level'),
  format: z.enum(['ASCII', 'HTML', 'URI', 'UTF8', 'QRCODE']).describe('Content encoding format'),
  content: z.string().min(1).max(1024),
  language: z.string().max(8).optional().describe('ISO 639-1 language code'),
  state: z
    .enum(['Charging', 'Faulted', 'Idle', 'Unavailable', 'Suspended', 'Discharging'])
    .optional()
    .describe('Show message only when station is in this state'),
  startDateTime: z.string().datetime().optional().describe('ISO 8601 start time for the message'),
  endDateTime: z.string().datetime().optional().describe('ISO 8601 end time for the message'),
  transactionId: z.string().max(36).optional().describe('Limit display to this transaction'),
  evseId: z.coerce.number().int().min(0).optional().describe('OCPP EVSE ID to target'),
  messageExtra: z
    .array(z.record(z.unknown()))
    .optional()
    .describe('Additional OCPP message components'),
});

export function displayMessageRoutes(app: FastifyInstance): void {
  // List display messages for a station
  app.get(
    '/stations/:stationId/display-messages',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Display Messages'],
        summary: 'List display messages for a station',
        operationId: 'listDisplayMessages',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        querystring: zodSchema(listMessagesQuery),
        response: { 200: paginatedResponse(displayMessageItem) },
      },
    },
    async (request) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const query = request.query as z.infer<typeof listMessagesQuery>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(stationId, userId))) {
        return { data: [], total: 0 };
      }

      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const conditions = [eq(displayMessages.stationId, stationId)];
      if (query.status != null) {
        conditions.push(eq(displayMessages.status, query.status));
      }

      const where = and(...conditions);

      const [data, totalResult] = await Promise.all([
        db
          .select()
          .from(displayMessages)
          .where(where)
          .orderBy(desc(displayMessages.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(displayMessages).where(where),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Create and send a display message
  app.post(
    '/stations/:stationId/display-messages',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Display Messages'],
        summary: 'Create and send a display message to a station',
        operationId: 'createDisplayMessage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(createMessageBody),
        response: {
          200: itemResponse(displayMessageItem),
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
          502: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const body = request.body as z.infer<typeof createMessageBody>;

      // Find station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Generate next ocppMessageId for this station
      const maxResult = await db
        .select({ maxId: sql<number>`COALESCE(MAX(${displayMessages.ocppMessageId}), 0)` })
        .from(displayMessages)
        .where(eq(displayMessages.stationId, stationId));
      const ocppMessageId = (maxResult[0]?.maxId ?? 0) + 1;

      // Insert row with pending status
      const [message] = await db
        .insert(displayMessages)
        .values({
          stationId,
          ocppMessageId,
          priority: body.priority,
          status: 'pending',
          format: body.format,
          content: body.content,
          language: body.language ?? null,
          state: body.state ?? null,
          startDateTime: body.startDateTime != null ? new Date(body.startDateTime) : null,
          endDateTime: body.endDateTime != null ? new Date(body.endDateTime) : null,
          transactionId: body.transactionId ?? null,
          evseId: body.evseId ?? null,
          messageExtra: body.messageExtra ?? null,
        })
        .returning();

      if (message == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create message', code: 'MESSAGE_CREATE_FAILED' });
        return;
      }

      // Build OCPP SetDisplayMessage payload
      const messageContent: Record<string, unknown> = {
        format: body.format,
        content: body.content,
      };
      if (body.language != null) messageContent['language'] = body.language;

      const messageInfo: Record<string, unknown> = {
        id: ocppMessageId,
        priority: body.priority,
        message: messageContent,
      };
      if (body.state != null) messageInfo['state'] = body.state;
      if (body.startDateTime != null) messageInfo['startDateTime'] = body.startDateTime;
      if (body.endDateTime != null) messageInfo['endDateTime'] = body.endDateTime;
      if (body.transactionId != null) messageInfo['transactionId'] = body.transactionId;
      if (body.evseId != null) {
        messageInfo['display'] = { evse: { id: body.evseId } };
      }

      const result = await sendOcppCommandAndWait(station.stationId, 'SetDisplayMessage', {
        message: messageInfo,
      });

      if (result.error != null) {
        const isTimeout = result.error.includes('No response within');
        await reply.status(isTimeout ? 504 : 502).send({
          error: result.error,
          code: isTimeout ? 'MESSAGE_TIMEOUT' : 'MESSAGE_SEND_FAILED',
        });
        return;
      }

      // Update status based on station response
      const responseStatus = result.response?.['status'] as string | undefined;
      const newStatus =
        responseStatus === 'Accepted' ? ('accepted' as const) : ('rejected' as const);

      const [updated] = await db
        .update(displayMessages)
        .set({ status: newStatus, ocppResponse: result.response ?? null, updatedAt: new Date() })
        .where(eq(displayMessages.id, message.id))
        .returning();

      return updated;
    },
  );

  // Clear a display message
  app.delete(
    '/stations/:stationId/display-messages/:id',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Display Messages'],
        summary: 'Clear a display message from a station',
        operationId: 'clearDisplayMessage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(messageIdParams),
        response: {
          200: itemResponse(clearMessageResponse),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId, id } = request.params as z.infer<typeof messageIdParams>;

      const [message] = await db
        .select({
          id: displayMessages.id,
          ocppMessageId: displayMessages.ocppMessageId,
          status: displayMessages.status,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
        })
        .from(displayMessages)
        .innerJoin(chargingStations, eq(displayMessages.stationId, chargingStations.id))
        .where(and(eq(displayMessages.id, id), eq(displayMessages.stationId, stationId)));

      if (message == null) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && message.siteId != null && !siteIds.includes(message.siteId)) {
        await reply.status(404).send({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }

      if (message.status !== 'accepted') {
        await reply.status(400).send({
          error: 'Only accepted messages can be cleared',
          code: 'MESSAGE_NOT_CLEARABLE',
        });
        return;
      }

      const result = await sendOcppCommandAndWait(message.stationOcppId, 'ClearDisplayMessage', {
        id: message.ocppMessageId,
      });

      if (result.error != null) {
        const isTimeout = result.error.includes('No response within');
        await reply.status(isTimeout ? 504 : 502).send({
          error: result.error,
          code: isTimeout ? 'MESSAGE_TIMEOUT' : 'MESSAGE_CLEAR_FAILED',
        });
        return;
      }

      const responseStatus = result.response?.['status'] as string | undefined;
      if (responseStatus !== 'Accepted') {
        await reply.status(400).send({
          error: `Station rejected clear: ${responseStatus ?? 'Unknown'}`,
          code: 'MESSAGE_CLEAR_REJECTED',
        });
        return;
      }

      await db
        .update(displayMessages)
        .set({ status: 'cleared', ocppResponse: result.response ?? null, updatedAt: new Date() })
        .where(eq(displayMessages.id, id));

      return { status: 'cleared' };
    },
  );

  // Refresh display messages from station
  app.post(
    '/stations/:stationId/display-messages/refresh',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Display Messages'],
        summary: 'Refresh display messages from a station',
        operationId: 'refreshDisplayMessages',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(refreshMessageResponse),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const requestId = Math.floor(Math.random() * 2147483647);

      const result = await sendOcppCommandAndWait(station.stationId, 'GetDisplayMessages', {
        requestId,
      });

      if (result.error != null) {
        const isTimeout = result.error.includes('No response within');
        await reply.status(isTimeout ? 504 : 502).send({
          error: result.error,
          code: isTimeout ? 'MESSAGE_TIMEOUT' : 'MESSAGE_REFRESH_FAILED',
        });
        return;
      }

      const responseStatus = result.response?.['status'] as string | undefined;
      return { status: responseStatus ?? 'Unknown' };
    },
  );
}
