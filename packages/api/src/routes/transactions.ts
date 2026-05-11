// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  transactionEventTypeEnum,
  sessionStatusEnum,
} from '@evtivity/database';
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

const transactionEventItem = z
  .object({
    id: z.number().int().min(1).describe('Internal transaction event ID'),
    sessionId: z.string().describe('Charging session ID'),
    eventType: z.enum(transactionEventTypeEnum.enumValues).describe('Transaction event type'),
    seqNo: z.number().int().min(0).describe('Sequence number from the station'),
    timestamp: z.string().describe('Timestamp the event occurred at the station'),
    triggerReason: z.string().max(50).describe('Reason that triggered the event'),
    offline: z.boolean().describe('Whether the event was queued offline'),
    numberOfPhasesUsed: z
      .number()
      .int()
      .min(1)
      .max(3)
      .nullable()
      .describe('Number of phases in use during the event'),
    cableMaxCurrent: z.number().min(0).nullable().describe('Cable max current rating in amps'),
    payload: z.record(z.unknown()).nullable().describe('Raw OCPP transaction event payload'),
    createdAt: z.string().describe('Timestamp the row was inserted in the CSMS'),
  })
  .passthrough();

const transactionSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    stationId: z.string().describe('Charging station ID'),
    evseId: z.string().nullable().describe('EVSE ID'),
    connectorId: z.string().nullable().describe('Connector ID'),
    driverId: z.string().nullable().describe('Driver ID associated with the session'),
    transactionId: z.string().describe('OCPP transaction ID'),
    status: z.enum(sessionStatusEnum.enumValues).describe('Session status'),
    startedAt: z.string().nullable().describe('Session start timestamp'),
    endedAt: z.string().nullable().describe('Session end timestamp'),
    meterStart: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Energy meter reading at session start (Wh)'),
    meterStop: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Energy meter reading at session end (Wh)'),
    energyDeliveredWh: z.string().nullable().describe('Energy delivered in Wh'),
    stoppedReason: z.string().nullable().describe('Reason the session ended'),
    isRoaming: z.boolean().describe('Whether the session is a roaming session'),
    remoteStartId: z.number().nullable().describe('OCPP remoteStart correlation ID'),
    reservationId: z.string().nullable().describe('Reservation ID linked to the session'),
    currentCostCents: z.number().int().min(0).nullable().describe('Running cost in cents'),
    finalCostCents: z.number().int().min(0).nullable().describe('Final cost in cents'),
    currency: z.string().length(3).nullable().describe('Currency code (ISO 4217)'),
    tariffId: z.string().nullable().describe('Tariff ID applied to the session'),
    tariffPricePerKwh: z.string().nullable().describe('Tariff energy price snapshot'),
    tariffPricePerMinute: z.string().nullable().describe('Tariff time price snapshot'),
    tariffPricePerSession: z.string().nullable().describe('Tariff session fee snapshot'),
    tariffIdleFeePricePerMinute: z.string().nullable().describe('Tariff idle fee snapshot'),
    tariffTaxRate: z.string().nullable().describe('Tariff tax rate snapshot'),
    idleStartedAt: z.string().nullable().describe('Timestamp when the session became idle'),
    idleMinutes: z.string().describe('Accumulated idle minutes'),
    lastUpdateNotifiedAt: z
      .string()
      .nullable()
      .describe('Last driver-update notification timestamp'),
    metadata: z.record(z.unknown()).nullable().describe('Free-form metadata'),
    freeVend: z.boolean().describe('Whether the session ran in free vend mode'),
    co2AvoidedKg: z.string().nullable().describe('Estimated CO2 avoided in kg'),
    createdAt: z.string().describe('Row creation timestamp'),
    updatedAt: z.string().describe('Row last update timestamp'),
  })
  .passthrough();

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
