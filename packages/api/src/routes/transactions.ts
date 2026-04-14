// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, chargingSessions, chargingStations } from '@evtivity/database';
import * as transactionService from '../services/transaction.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  errorResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const transactionEventItem = z.object({}).passthrough();
const transactionSessionItem = z.object({}).passthrough();

const sessionParams = z.object({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const transactionIdParams = z.object({
  transactionId: z.string().describe('OCPP transaction ID'),
});

/** Check if user has site access to a session's station. Returns true if allowed. */
async function checkSessionSiteAccess(sessionId: string, userId: string): Promise<boolean> {
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return true;

  const [session] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(eq(chargingSessions.id, sessionId));

  if (session == null) return true;
  if (session.siteId == null) return true;
  return siteIds.includes(session.siteId);
}

export function transactionRoutes(app: FastifyInstance): void {
  app.get(
    '/transactions',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Transactions'],
        summary: 'List transaction events',
        operationId: 'listTransactions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(transactionEventItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };

      const params = request.query as z.infer<typeof paginationQuery>;
      return transactionService.listTransactionEvents(params, siteIds);
    },
  );

  app.get(
    '/transactions/by-session/:sessionId',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Transactions'],
        summary: 'Get transaction events for a session',
        operationId: 'getTransactionsBySession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: { 200: arrayResponse(transactionEventItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as z.infer<typeof sessionParams>;
      const { userId } = request.user as { userId: string };

      if (!(await checkSessionSiteAccess(sessionId, userId))) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      return transactionService.getTransactionEventsBySession(sessionId);
    },
  );

  app.get(
    '/transactions/by-transaction-id/:transactionId',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Transactions'],
        summary: 'Get session by OCPP transaction ID',
        operationId: 'getTransactionById',
        security: [{ bearerAuth: [] }],
        params: zodSchema(transactionIdParams),
        response: { 200: itemResponse(transactionSessionItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { transactionId } = request.params as z.infer<typeof transactionIdParams>;
      const session = await transactionService.getSessionByTransactionId(transactionId);
      if (session == null) {
        await reply
          .status(404)
          .send({ error: 'Transaction not found', code: 'TRANSACTION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [stationRow] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, session.stationId));
        if (stationRow?.siteId != null && !siteIds.includes(stationRow.siteId)) {
          await reply
            .status(404)
            .send({ error: 'Transaction not found', code: 'TRANSACTION_NOT_FOUND' });
          return;
        }
      }

      return session;
    },
  );
}
