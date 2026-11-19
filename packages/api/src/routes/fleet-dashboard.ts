// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, fleets, getCompanyCurrency, getSystemTimezone } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { fleetReaderOf } from '../lib/fleet-reader.js';
import { dateRangeQuery, resolveCalendarRange } from '../lib/date-range.js';
import {
  getFleetDashboardSummary,
  listFleetDashboardSessions,
} from '../services/fleet-dashboard.service.js';
import { paginationQuery } from '../lib/pagination.js';
import { paginatedResponse } from '../lib/response-schemas.js';
import { sessionChargingPointShape } from '../lib/session-charging-point.js';

const summaryQuery = dateRangeQuery.extend({
  fleetId: ID_PARAMS.fleetId
    .optional()
    .describe(
      'The fleet to summarize; left out for every fleet the caller sees (a fleet user: its assigned fleets)',
    ),
});

const summaryItem = z
  .object({
    fleetId: z.string().nullable().describe('The fleet summarized, null for every fleet'),
    sessionCount: z.number().int().describe('Sessions started in the range'),
    energyWh: z.number().describe('Energy delivered by those sessions, in Wh'),
    costCents: z
      .number()
      .optional()
      .describe(
        'Cost of those sessions in the company currency, in cents (final cost, else the running cost). Only with payments:read',
      ),
    currency: z.string().optional().describe('The company currency. Only with payments:read'),
    creditLimit: z
      .object({
        fleetId: z.string().describe('The fleet that used the largest share of its credit limit'),
        fleetName: z.string().describe('Its name'),
        limitCents: z.number().describe('Its credit limit, in cents'),
        exposureCents: z.number().describe('Its credit exposure, in cents'),
        usedPercent: z.number().describe('Its exposure as a percent of its limit, one decimal'),
        fleetCount: z.number().int().describe('Fleets with a credit limit in the summary'),
      })
      .loose()
      .nullable()
      .optional()
      .describe(
        'The credit limit used by the fleet of the summary closest to its limit (the highest share among the fleets that have one; one fleet: its own), null when no fleet of the summary has a limit. Only with payments:read, for a fleet user or a user with access to every site',
      ),
    history: z
      .array(
        z
          .object({
            date: z.string().describe('Calendar date (YYYY-MM-DD) in the system timezone'),
            sessions: z.number().int().describe('Sessions started that day'),
            energyWh: z.number().describe('Energy of those sessions, in Wh'),
            costCents: z
              .number()
              .optional()
              .describe('Their cost in cents of the company currency. Only with payments:read'),
          })
          .loose(),
      )
      .describe('One row per day of the range, a day without sessions at 0'),
    invoices: z
      .array(
        z
          .object({
            id: z.string().describe('Invoice ID'),
            invoiceNumber: z.string().describe('Invoice number'),
            fleetId: z.string().nullable().describe('The fleet invoiced'),
            fleetName: z.string().describe('Its name'),
            kind: z.string().describe('invoice or credit_note'),
            status: z.string().describe('Invoice status (issued, paid, credited, void)'),
            totalCents: z.number().int().describe('Total in cents, tax included'),
            currency: z.string().describe('Currency of the invoice'),
            issuedAt: z.coerce.date().nullable().describe('When the invoice was issued'),
            createdAt: z.coerce.date().describe('When the invoice was created'),
          })
          .loose(),
      )
      .optional()
      .describe(
        'The newest fleet invoices and credit notes of the summary (never member invoices), at most 5. Only with payments:read, for a fleet user or a user with access to every site',
      ),
  })
  .loose();

const sessionsQuery = paginationQuery.pick({ page: true, limit: true }).extend({
  fleetId: ID_PARAMS.fleetId
    .optional()
    .describe(
      'The fleet whose sessions to list; left out for every fleet the caller sees (a fleet user: its assigned fleets)',
    ),
});

const dashboardSessionItem = z
  .object({
    id: z.string().describe('Session ID'),
    fleetId: z.string().nullable().describe('The fleet the session is billed to on account'),
    fleetName: z.string().nullable().describe('Its name'),
    stationId: z.string().describe('Station ID'),
    stationName: z.string().nullable().describe('OCPP identity of the station'),
    siteName: z.string().nullable().describe('Site name'),
    ...sessionChargingPointShape,
    status: z.string().describe('Session status'),
    startedAt: z.coerce.date().nullable().describe('When the session started'),
    endedAt: z.coerce.date().nullable().describe('When the session ended'),
    idleStartedAt: z.coerce.date().nullable().describe('When the vehicle stopped drawing power'),
    energyDeliveredWh: z.coerce.number().nullable().describe('Energy delivered, in Wh'),
    currentCostCents: z
      .number()
      .nullable()
      .optional()
      .describe('Running cost in cents. Only with payments:read'),
    finalCostCents: z
      .number()
      .nullable()
      .optional()
      .describe('Final cost in cents. Only with payments:read'),
    currency: z.string().optional().describe('Currency of the session. Only with payments:read'),
  })
  .loose();

export function fleetDashboardRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets/dashboard-sessions',
    {
      onRequest: [authorize('fleets:read', 'sessions:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List the newest charging sessions of the fleets for the Dashboard',
        description:
          'The Dashboard Charging Sessions item: the newest sessions first, in the fleet session scope. A fleet user sees the sessions billed to its assigned fleets on account at every site, and a fleetId it is not assigned answers 404 FLEET_NOT_FOUND; an operator the sessions of the fleets members and RFID cards at its sites. No RFID card value or transaction id; the cost only with payments:read.',
        operationId: 'listFleetDashboardSessions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sessionsQuery),
        response: {
          200: paginatedResponse(dashboardSessionItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof sessionsQuery>;
      const reader = await fleetReaderOf(request);
      const fleetId = query.fleetId ?? null;
      if (fleetId != null && !(await knownFleet(reader, fleetId))) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return listFleetDashboardSessions(reader, {
        fleetIds: fleetId == null ? 'all' : [fleetId],
        page: query.page,
        limit: query.limit,
        money: await requestHasPermission(request, 'payments:read'),
      });
    },
  );

  app.get(
    '/fleets/metrics-summary',
    {
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Get the fleet summary of the Dashboard',
        description:
          'Sessions, energy and (with payments:read) cost per day of the fleets over a date range, with the credit limit used and the latest fleet invoices for a fleet user or a user with access to every site. An operator covers the sessions of the fleets members and RFID cards at its sites; a fleet user the sessions billed to its assigned fleets at every site, and a fleetId it is not assigned answers 404 FLEET_NOT_FOUND.',
        operationId: 'getFleetMetricsSummary',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(summaryQuery),
        response: {
          200: itemResponse(summaryItem),
          400: errorWith('Invalid date range', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof summaryQuery>;
      const reader = await fleetReaderOf(request);
      const fleetId = query.fleetId ?? null;
      if (fleetId != null && !(await knownFleet(reader, fleetId))) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const timeZone = await getSystemTimezone();
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        timeZone,
      );
      const money = await requestHasPermission(request, 'payments:read');
      const billing = money && (reader.kind === 'fleets' || reader.siteIds == null);
      const summary = await getFleetDashboardSummary(reader, {
        fleetIds: fleetId == null ? 'all' : [fleetId],
        range,
        timeZone,
        companyCurrency: money ? await getCompanyCurrency() : '',
        money,
        billing,
      });
      return { fleetId, ...summary };
    },
  );
}

/** A fleet the reader may name: a fleet user one of its fleets, an operator any existing fleet. */
async function knownFleet(
  reader: Awaited<ReturnType<typeof fleetReaderOf>>,
  fleetId: string,
): Promise<boolean> {
  if (reader.kind === 'fleets') return reader.fleetIds.includes(fleetId);
  const rows = await db.select({ id: fleets.id }).from(fleets).where(eq(fleets.id, fleetId));
  return rows.length > 0;
}
