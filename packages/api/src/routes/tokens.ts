// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  drivers,
  sites,
  driverTokens,
} from '@evtivity/database';
import * as tokenService from '../services/token.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';

const tokenItem = z
  .object({
    id: z.string().describe('Token ID'),
    driverId: z.string().nullable().describe('Assigned driver ID, null if unassigned'),
    idToken: z.string().describe('Token identifier (e.g. RFID UID)'),
    tokenType: z.string().describe('OCPP IdToken type (ISO14443, ISO15693, Central, eMAID, etc.)'),
    isActive: z.boolean().describe('Whether the token can be used to authorize charging'),
    createdAt: z.coerce.date().describe('Timestamp when the token was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the token was last updated'),
    driverFirstName: z
      .string()
      .nullable()
      .describe('Assigned driver first name, null if unassigned'),
    driverLastName: z.string().nullable().describe('Assigned driver last name, null if unassigned'),
    driverEmail: z.string().nullable().describe('Assigned driver email, null if unassigned'),
  })
  .passthrough();

const tokenCreated = z
  .object({
    id: z.string().describe('Token ID'),
    driverId: z.string().nullable().describe('Assigned driver ID, null if unassigned'),
    idToken: z.string().describe('Token identifier (e.g. RFID UID)'),
    tokenType: z.string().describe('OCPP IdToken type (ISO14443, ISO15693, Central, eMAID, etc.)'),
    isActive: z.boolean().describe('Whether the token can be used to authorize charging'),
    createdAt: z.coerce.date().describe('Timestamp when the token was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the token was last updated'),
  })
  .passthrough();

const tokenImportResult = z
  .object({
    imported: z.number().describe('Number of tokens successfully imported'),
    errors: z.array(z.string()).describe('List of error messages for rows that failed to import'),
  })
  .passthrough();

const tokenSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    stationId: z.string().describe('Charging station ID'),
    stationName: z.string().nullable().describe('Station OCPP identifier, null if unavailable'),
    siteName: z.string().nullable().describe('Site name, null if station has no site'),
    driverId: z.string().nullable().describe('Driver ID, null for guest or free-vend sessions'),
    driverName: z
      .string()
      .nullable()
      .describe('Driver full name, null for guest or unassigned sessions'),
    transactionId: z.string().nullable().describe('OCPP transaction ID, null if not yet assigned'),
    status: z.string().describe('Session status (active, completed, failed, faulted, etc.)'),
    startedAt: z.coerce.date().describe('Timestamp when the session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, null if still active'),
    energyDeliveredWh: z.coerce
      .number()
      .nullable()
      .describe('Energy delivered in watt-hours, null if not yet measured'),
    currentCostCents: z
      .number()
      .nullable()
      .describe('Current accumulated cost in cents, null if free or not yet calculated'),
    finalCostCents: z
      .number()
      .nullable()
      .describe('Final cost in cents after session ended, null if session still active'),
    currency: z.string().nullable().describe('ISO 4217 currency code, null if session has no cost'),
  })
  .passthrough();

const tokenParams = z.object({
  id: ID_PARAMS.driverTokenId.describe('Token ID'),
});

const createTokenBody = z.object({
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to assign this token to'),
  idToken: z.string().max(255).describe('Token identifier (e.g. RFID card UID)'),
  tokenType: z
    .string()
    .max(20)
    .describe('OCPP IdToken type (e.g. ISO14443, ISO15693, Central, eMAID)'),
});

const updateTokenBody = z.object({
  idToken: z.string().max(255).optional().describe('Token identifier (e.g. RFID card UID)'),
  tokenType: z
    .string()
    .max(20)
    .optional()
    .describe('OCPP IdToken type (e.g. ISO14443, ISO15693, Central, eMAID)'),
  driverId: ID_PARAMS.driverId
    .nullable()
    .optional()
    .describe('Driver ID to assign this token to, or null to unassign'),
  isActive: z.boolean().optional().describe('Whether the token is active'),
});

const importTokenRow = z.object({
  idToken: z.string().min(1).max(255),
  tokenType: z.string().min(1).max(20),
  driverEmail: z.string().email().max(255).optional(),
  isActive: z.boolean().optional(),
});

const importTokenBody = z.object({
  rows: z.array(importTokenRow).max(10000),
});

const tokenListQuery = paginationQuery.extend({
  tokenType: z.string().max(20).optional().describe('Filter by token type'),
  status: z.enum(['active', 'inactive']).optional().describe('Filter by token status'),
});

export function tokenRoutes(app: FastifyInstance): void {
  app.get(
    '/tokens/filter-options',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'Get distinct token types for filtering',
        operationId: 'getTokenFilterOptions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                tokenTypes: z
                  .array(z.string())
                  .describe('Distinct OCPP IdToken type values present in the system'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async () => {
      const rows = await db
        .selectDistinct({ tokenType: driverTokens.tokenType })
        .from(driverTokens)
        .orderBy(driverTokens.tokenType);
      return { tokenTypes: rows.map((r) => r.tokenType) };
    },
  );

  app.get(
    '/tokens',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'List all tokens with pagination',
        operationId: 'listTokens',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(tokenListQuery),
        response: { 200: paginatedResponse(tokenItem) },
      },
    },
    async (request) => {
      const params = request.query as z.infer<typeof tokenListQuery>;
      return tokenService.listTokens(params);
    },
  );

  app.get(
    '/tokens/export',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'Export tokens as CSV',
        operationId: 'exportTokens',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
      },
    },
    async (request, reply) => {
      const params = request.query as z.infer<typeof paginationQuery>;
      const csv = await tokenService.exportTokensCsv(params.search);
      await reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename=tokens.csv')
        .send(csv);
    },
  );

  app.post(
    '/tokens/import',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Tokens'],
        summary: 'Import tokens from parsed CSV rows',
        operationId: 'importTokens',
        security: [{ bearerAuth: [] }],
        body: zodSchema(importTokenBody),
        response: { 200: itemResponse(tokenImportResult) },
      },
    },
    async (request) => {
      const { rows } = request.body as z.infer<typeof importTokenBody>;
      return tokenService.importTokensCsv(rows);
    },
  );

  app.get(
    '/tokens/:id/sessions',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'List charging sessions for a token',
        operationId: 'listTokenSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(tokenSessionItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const token = await tokenService.getToken(id);
      if (token == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }

      if (token.driverId == null) {
        return { data: [], total: 0 } satisfies PaginatedResponse<unknown>;
      }

      const where = eq(chargingSessions.driverId, token.driverId);

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: chargingSessions.id,
            stationId: chargingSessions.stationId,
            stationName: chargingStations.stationId,
            siteName: sites.name,
            driverId: chargingSessions.driverId,
            driverName: sql<
              string | null
            >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
            transactionId: chargingSessions.transactionId,
            status: chargingSessions.status,
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
          .where(where)
          .orderBy(desc(chargingSessions.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/tokens/:id',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'Get a token by ID',
        operationId: 'getToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        response: { 200: itemResponse(tokenItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const token = await tokenService.getToken(id);
      if (token == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      return token;
    },
  );

  app.post(
    '/tokens',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Tokens'],
        summary: 'Create a new token',
        operationId: 'createToken',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTokenBody),
        response: { 201: itemResponse(tokenCreated) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTokenBody>;
      const token = await tokenService.createToken(body);
      await reply.status(201).send(token);
    },
  );

  app.patch(
    '/tokens/:id',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Tokens'],
        summary: 'Update a token by ID',
        operationId: 'updateToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        body: zodSchema(updateTokenBody),
        response: { 200: itemResponse(tokenCreated), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const body = request.body as z.infer<typeof updateTokenBody>;
      const token = await tokenService.updateToken(id, body);
      if (token == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      return token;
    },
  );

  app.delete(
    '/tokens/:id',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Tokens'],
        summary: 'Delete a token by ID',
        operationId: 'deleteToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        response: { 200: itemResponse(tokenCreated), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const token = await tokenService.deleteToken(id);
      if (token == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      return token;
    },
  );
}
