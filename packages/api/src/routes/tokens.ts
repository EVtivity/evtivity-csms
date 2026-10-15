// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  drivers,
  sites,
  driverTokens,
  inOperatorStation,
} from '@evtivity/database';
import * as tokenService from '../services/token.service.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { OCPP_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { sessionsAtSites } from '../lib/session-site-scope.js';
import { getAuditActor } from '../lib/audit-actor.js';

const tokenTypeSchema = z.enum(OCPP_ID_TOKEN_TYPES);

const prepaidBalanceSchema = z
  .number()
  .int()
  .min(-100_000_000)
  .max(100_000_000)
  .nullable()
  .optional()
  .describe(
    'Prepaid credit in cents of the company currency (OCPP 2.1 prepaid card). Null makes the token postpaid',
  );

const tokenItem = z
  .object({
    id: z.string().describe('Token ID'),
    driverId: z.string().nullable().describe('Assigned driver ID, null if unassigned'),
    idToken: z.string().describe('Token identifier (e.g. RFID UID)'),
    tokenType: z.string().describe('OCPP IdToken type (ISO14443, ISO15693, Central, eMAID, etc.)'),
    isActive: z.boolean().describe('Whether the token can be used to authorize charging'),
    expiresAt: z.coerce.date().nullable().describe('Optional expiration timestamp'),
    revokedAt: z.coerce.date().nullable().describe('Timestamp the token was last deactivated'),
    revokedReason: z.string().nullable().describe('Optional operator-supplied reason'),
    deactivatedBy: z
      .enum(['operator', 'driver', 'system'])
      .nullable()
      .describe(
        'Who deactivated the token, null while active. A driver can reactivate only a token the driver deactivated',
      ),
    prepaidBalanceCents: z
      .number()
      .int()
      .nullable()
      .describe(
        'Prepaid credit in cents of the company currency. Null when the token is not prepaid; zero or less is answered NoCredit',
      ),
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
    tokenType: z.string().describe('OCPP IdToken type'),
    isActive: z.boolean().describe('Whether the token can be used to authorize charging'),
    expiresAt: z.coerce.date().nullable().describe('Optional expiration timestamp'),
    revokedAt: z.coerce.date().nullable().describe('Timestamp the token was last deactivated'),
    revokedReason: z.string().nullable().describe('Optional operator-supplied reason'),
    prepaidBalanceCents: z
      .number()
      .int()
      .nullable()
      .describe(
        'Prepaid credit in cents of the company currency. Null when the token is not prepaid; zero or less is answered NoCredit',
      ),
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
    status: z.string().describe('Session status'),
    startedAt: z.coerce.date().describe('Timestamp when the session started'),
    endedAt: z.coerce.date().nullable().describe('Timestamp when the session ended'),
    energyDeliveredWh: z.coerce.number().nullable().describe('Energy delivered in Wh'),
    currentCostCents: z.number().nullable().describe('Current accumulated cost in cents'),
    finalCostCents: z.number().nullable().describe('Final cost in cents'),
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
  })
  .passthrough();

const tokenParams = z.object({
  id: ID_PARAMS.driverTokenId.describe('Token ID'),
});

const createTokenBody = z.object({
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to assign this token to'),
  idToken: z.string().min(1).max(255).describe('Token identifier'),
  tokenType: tokenTypeSchema.describe('OCPP IdToken type'),
  expiresAt: z.coerce.date().nullable().optional().describe('Optional expiration timestamp'),
  prepaidBalanceCents: prepaidBalanceSchema,
});

const updateTokenBody = z.object({
  idToken: z.string().min(1).max(255).optional().describe('Token identifier'),
  tokenType: tokenTypeSchema.optional().describe('OCPP IdToken type'),
  driverId: ID_PARAMS.driverId
    .nullable()
    .optional()
    .describe('Driver ID to assign this token to, or null to unassign'),
  isActive: z.boolean().optional().describe('Whether the token is active'),
  expiresAt: z.coerce
    .date()
    .nullable()
    .optional()
    .describe('Optional expiration timestamp; null clears expiry'),
  revokedReason: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe('Optional reason recorded when the token is deactivated'),
  prepaidBalanceCents: prepaidBalanceSchema,
});

const bulkActiveBody = z.object({
  ids: z.array(ID_PARAMS.driverTokenId).min(1).max(500).describe('Token IDs to update'),
  isActive: z.boolean().describe('New active state to apply to every token in ids'),
});

// Each field is checked per row by the importer, which reports a bad row in
// `errors` instead of failing the whole file.
const importTokenRow = z.object({
  idToken: z.string().max(1000).describe('Token identifier, at most 255 characters'),
  tokenType: z.string().max(50).describe('OCPP IdToken type'),
  driverEmail: z.string().max(255).optional().describe('Email of the driver to assign'),
  isActive: z.boolean().optional().describe('Whether the token is active (default true)'),
  expiresAt: z.string().max(50).optional().describe('ISO 8601 expiry, empty for none'),
});

const importTokenBody = z.object({
  rows: z.array(importTokenRow).max(10000),
});

const tokenFilterQuery = {
  tokenType: z.string().max(20).optional().describe('Filter by token type'),
  status: z.enum(['active', 'inactive']).optional().describe('Filter by token status'),
};

const tokenListQuery = paginationQuery.extend(tokenFilterQuery);

const tokenExportQuery = z.object({
  search: z.string().max(255).optional().describe('Search token value or driver name or email'),
  ...tokenFilterQuery,
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
        description:
          'Every token matching the same filters as the list (search, tokenType, status), as CSV with the columns idToken, tokenType, driverEmail, isActive and expiresAt. The import reads the same columns.',
        operationId: 'exportTokens',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(tokenExportQuery),
      },
    },
    async (request, reply) => {
      const params = request.query as z.infer<typeof tokenExportQuery>;
      const csv = await tokenService.exportTokensCsv(params);
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
      return tokenService.importTokensCsv(rows, tokenService.tokenActorOf(getAuditActor(request)));
    },
  );

  app.post(
    '/tokens/bulk-active',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Tokens'],
        summary: 'Bulk activate or deactivate tokens',
        operationId: 'bulkSetTokensActive',
        security: [{ bearerAuth: [] }],
        body: zodSchema(bulkActiveBody),
        description:
          'Activates or deactivates the tokens. Only tokens not already in that state change. Activation is refused with 409 DRIVER_INACTIVE when one of the tokens belongs to a deactivated driver.',
        response: {
          200: itemResponse(
            z
              .object({ updated: z.number().int().min(0).describe('Number of tokens updated') })
              .passthrough(),
          ),
          409: errorWith('Inactive driver or a revoked Plug and Charge contract', [
            ERROR_CODES.DRIVER_INACTIVE,
            ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { ids, isActive } = request.body as z.infer<typeof bulkActiveBody>;
      try {
        return await tokenService.bulkSetActive(
          ids,
          isActive,
          tokenService.tokenActorOf(getAuditActor(request)),
        );
      } catch (err) {
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(409).send({
            error: 'This token is the eMAID of a Plug and Charge contract',
            code: 'PNC_CONTRACT_TOKEN_LOCKED',
          });
          return;
        }
        if (err instanceof tokenService.TokenDriverInactiveError) {
          await reply.status(409).send({ error: 'Driver is inactive', code: 'DRIVER_INACTIVE' });
          return;
        }
        throw err;
      }
    },
  );

  app.get(
    '/tokens/:id/sessions',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'List charging sessions authorized by this token',
        description:
          'The charging sessions this token authorized, newest first. A user restricted to some sites sees only the sessions at those sites.',
        operationId: 'listTokenSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(tokenSessionItem),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
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

      // Filter by token_id directly (the FK on charging_sessions). This shows
      // sessions where the OCPP authorize matched THIS card, not every session
      // by the same driver.
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      const where = and(
        eq(chargingSessions.tokenId, id),
        siteIds != null ? sessionsAtSites(siteIds) : undefined,
        // Sessions of conformance test stations are never listed.
        inOperatorStation(chargingSessions.stationId),
      );

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
            currency: sessionCurrencySql(),
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingSessions.siteId, sites.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
          .where(where)
          .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
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
        response: {
          200: itemResponse(tokenItem),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
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
        response: {
          201: itemResponse(tokenCreated),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          409: errorWith('Duplicate token, inactive driver, or a Plug and Charge contract token', [
            ERROR_CODES.TOKEN_DUPLICATE,
            ERROR_CODES.DRIVER_INACTIVE,
            ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = parseZodRequest(createTokenBody, request.body);
      try {
        const token = await tokenService.createToken(
          body,
          tokenService.tokenActorOf(getAuditActor(request)),
        );
        await reply.status(201).send(token);
      } catch (err) {
        if (err instanceof tokenService.TokenDriverNotFoundError) {
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        }
        if (err instanceof tokenService.TokenDriverInactiveError) {
          await reply.status(409).send({ error: 'Driver is inactive', code: 'DRIVER_INACTIVE' });
          return;
        }
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(409).send({
            error: 'This token is the eMAID of a Plug and Charge contract',
            code: 'PNC_CONTRACT_TOKEN_LOCKED',
          });
          return;
        }
        if (err instanceof tokenService.DuplicateTokenError) {
          await reply
            .status(409)
            .send({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
          return;
        }
        throw err;
      }
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
        response: {
          200: itemResponse(tokenCreated),
          404: errorWith('Token or driver not found', [
            ERROR_CODES.TOKEN_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
          409: errorWith('Duplicate token, inactive driver, or a Plug and Charge contract token', [
            ERROR_CODES.TOKEN_DUPLICATE,
            ERROR_CODES.DRIVER_INACTIVE,
            ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const body = parseZodRequest(updateTokenBody, request.body);
      try {
        const token = await tokenService.updateToken(
          id,
          body,
          tokenService.tokenActorOf(getAuditActor(request)),
        );
        if (token == null) {
          await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
          return;
        }
        return token;
      } catch (err) {
        if (err instanceof tokenService.TokenDriverNotFoundError) {
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        }
        if (err instanceof tokenService.TokenDriverInactiveError) {
          await reply.status(409).send({ error: 'Driver is inactive', code: 'DRIVER_INACTIVE' });
          return;
        }
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(409).send({
            error: 'This token is the eMAID of a Plug and Charge contract',
            code: 'PNC_CONTRACT_TOKEN_LOCKED',
          });
          return;
        }
        if (err instanceof tokenService.DuplicateTokenError) {
          await reply
            .status(409)
            .send({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
          return;
        }
        throw err;
      }
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
        response: {
          200: itemResponse(tokenCreated),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
          409: errorWith('Token in use, or the eMAID of an active Plug and Charge contract', [
            ERROR_CODES.TOKEN_IN_USE,
            ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;

      const [activeSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.tokenId, id), eq(chargingSessions.status, 'active')))
        .limit(1);
      if (activeSession != null) {
        await reply.status(409).send({
          error: 'Token is currently in use by an active charging session',
          code: 'TOKEN_IN_USE',
        });
        return;
      }

      let token: Awaited<ReturnType<typeof tokenService.deleteToken>>;
      try {
        token = await tokenService.deleteToken(
          id,
          tokenService.tokenActorOf(getAuditActor(request)),
        );
      } catch (err) {
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(409).send({
            error: 'This token is the eMAID of a Plug and Charge contract',
            code: 'PNC_CONTRACT_TOKEN_LOCKED',
          });
          return;
        }
        throw err;
      }
      if (token == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      return token;
    },
  );
}
