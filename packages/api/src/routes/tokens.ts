// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  drivers,
  sites,
  driverTokens,
  inOperatorStation,
} from '@evtivity/database';
import {
  sessionChargingPointColumns,
  sessionChargingPointShape,
  sessionConnector,
  sessionConnectorJoin,
  sessionEvse,
  sessionEvseJoin,
  sessionUnit,
  sessionUnitJoin,
} from '../lib/session-charging-point.js';
import * as tokenService from '../services/token.service.js';
import { tokenListSort } from '../lib/sorts/token-list-sort.js';
import { sessionListSort } from '../lib/sorts/session-list-sort.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { OCPP_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import { FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS } from '@evtivity/lib/fleet-card';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getUserSiteIds, isAllSiteUser } from '../lib/site-access.js';
import { sessionsAtSites } from '../lib/session-site-scope.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { tokenLabelSchema } from '../lib/token-label.js';

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
    label: z.string().nullable().describe('Free-text label of the token, null if none'),
    isActive: z.boolean().describe('Whether the token can be used to authorize charging'),
    expiresAt: z.coerce.date().nullable().describe('Optional expiration timestamp'),
    revokedAt: z.coerce.date().nullable().describe('Timestamp the token was last deactivated'),
    revokedReason: z.string().nullable().describe('Optional operator-supplied reason'),
    deactivatedBy: z
      .enum(['operator', 'driver', 'system', 'fleet'])
      .nullable()
      .describe(
        'Who deactivated the token, null while active (fleet: a fleet user). A driver can reactivate only a token the driver deactivated',
      ),
    prepaidBalanceCents: z
      .number()
      .int()
      .nullable()
      .describe(
        'Prepaid credit in cents of the company currency. Null when the token is not prepaid; zero or less is answered NoCredit',
      ),
    vehicleId: z
      .string()
      .nullable()
      .describe('Vehicle the card belongs to (a vehicle of the card driver), null for none'),
    fleetId: z
      .string()
      .nullable()
      .describe('Fleet that owns the card (a fleet RFID card), null for a driver card'),
    monthlyLimitCents: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Monthly spending limit of a fleet card in cents of the company currency, null for none',
      ),
    fleetName: z.string().nullable().describe('Name of the fleet that owns the card, null if none'),
    createdAt: z.coerce.date().describe('Timestamp when the token was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the token was last updated'),
    driverFirstName: z
      .string()
      .nullable()
      .describe('Assigned driver first name, null if unassigned'),
    driverLastName: z.string().nullable().describe('Assigned driver last name, null if unassigned'),
    driverEmail: z.string().nullable().describe('Assigned driver email, null if unassigned'),
  })
  .loose();

const tokenCreated = z
  .object({
    id: z.string().describe('Token ID'),
    driverId: z.string().nullable().describe('Assigned driver ID, null if unassigned'),
    idToken: z.string().describe('Token identifier (e.g. RFID UID)'),
    tokenType: z.string().describe('OCPP IdToken type'),
    label: z.string().nullable().describe('Free-text label of the token, null if none'),
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
    vehicleId: z
      .string()
      .nullable()
      .describe('Vehicle the card belongs to (a vehicle of the card driver), null for none'),
    fleetId: z
      .string()
      .nullable()
      .describe('Fleet that owns the card (a fleet RFID card), null for a driver card'),
    monthlyLimitCents: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Monthly spending limit of a fleet card in cents of the company currency, null for none',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the token was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the token was last updated'),
  })
  .loose();

const tokenImportResult = z
  .object({
    imported: z.number().describe('Number of tokens successfully imported'),
    errors: z.array(z.string()).describe('List of error messages for rows that failed to import'),
  })
  .loose();

const tokenSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    stationId: z.string().describe('Charging station ID'),
    stationName: z.string().nullable().describe('Station OCPP identifier, null if unavailable'),
    siteName: z.string().nullable().describe('Site name, null if station has no site'),
    ...sessionChargingPointShape,
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
  .loose();

const labelSchema = tokenLabelSchema(
  'Free-text label, e.g. "Pool RFID card, fleet 3", shown to the driver in the portal',
);

const tokenParams = z.object({
  id: ID_PARAMS.driverTokenId.describe('Token ID'),
});

const monthlyLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS)
  .nullable()
  .optional()
  .describe(
    'Most a fleet card may cost in one calendar month of the system timezone, in cents of the company currency (1 to 100000000); null for no limit. A card without a fleet answers 400 VALIDATION_ERROR; a card moved out of its fleet loses its limit',
  );

const createTokenBody = z.object({
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to assign this token to'),
  idToken: z.string().min(1).max(255).describe('Token identifier'),
  tokenType: tokenTypeSchema.describe('OCPP IdToken type'),
  label: labelSchema.nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional().describe('Optional expiration timestamp'),
  prepaidBalanceCents: prepaidBalanceSchema,
  vehicleId: ID_PARAMS.vehicleId
    .nullable()
    .optional()
    .describe(
      'Vehicle the card belongs to (a card per bus), a vehicle of the card driver; null for none. Another driver vehicle answers 400 VALIDATION_ERROR',
    ),
  fleetId: ID_PARAMS.fleetId
    .nullable()
    .optional()
    .describe(
      'Fleet that owns the card (a fleet RFID card), null for a driver card. A card with a fleet and a driver needs the driver to be an active member of that fleet (400 FLEET_CARD_DRIVER_NOT_MEMBER); an unknown fleet answers 404 FLEET_NOT_FOUND',
    ),
  monthlyLimitCents: monthlyLimitSchema,
});

const updateTokenBody = z
  .object({
    idToken: z.string().min(1).max(255).optional().describe('Token identifier'),
    tokenType: tokenTypeSchema.optional().describe('OCPP IdToken type'),
    driverId: ID_PARAMS.driverId
      .nullable()
      .optional()
      .describe('Driver ID to assign this token to, or null to unassign'),
    label: labelSchema.nullable().optional(),
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
    vehicleId: ID_PARAMS.vehicleId
      .nullable()
      .optional()
      .describe(
        'Vehicle the card belongs to (a card per bus), a vehicle of the card driver; null for none. Another driver vehicle answers 400 VALIDATION_ERROR',
      ),
    fleetId: ID_PARAMS.fleetId
      .nullable()
      .optional()
      .describe(
        'Fleet that owns the card (a fleet RFID card), null for a driver card. A card with a fleet and a driver needs the driver to be an active member of that fleet (400 FLEET_CARD_DRIVER_NOT_MEMBER); an unknown fleet answers 404 FLEET_NOT_FOUND',
      ),
    monthlyLimitCents: monthlyLimitSchema,
    expectedPrepaidBalanceCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'The balance the client read before changing prepaidBalanceCents (null for a postpaid token). Required with prepaidBalanceCents (400 VALIDATION_ERROR without it). The change applies only if the stored balance still equals it, else 409 PREPAID_BALANCE_CONFLICT, so a session debit in between is never overwritten. Send prepaidBalanceCents only to change it.',
      ),
  })
  .refine(
    (b) => b.prepaidBalanceCents === undefined || b.expectedPrepaidBalanceCents !== undefined,
    {
      message: 'expectedPrepaidBalanceCents is required with prepaidBalanceCents',
      path: ['expectedPrepaidBalanceCents'],
    },
  );

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
  label: z.string().max(1000).optional().describe('Free-text label, at most 100 characters'),
});

const importTokenBody = z.object({
  rows: z.array(importTokenRow).max(10000),
});

const tokenFilterQuery = {
  tokenType: z.string().max(20).optional().describe('Filter by token type'),
  status: z.enum(['active', 'inactive']).optional().describe('Filter by token status'),
  fleetId: ID_PARAMS.fleetId.optional().describe('Filter by the fleet that owns the card'),
};

const tokenListQuery = paginationQuery.extend({
  ...tokenFilterQuery,
  ...tokenListSort.query,
});

const tokenSessionsQuery = paginationQuery.extend({
  ...sessionListSort.query,
});

const tokenExportQuery = z.object({
  search: z.string().max(255).optional().describe('Search token value or driver name or email'),
  ...tokenFilterQuery,
});

const FLEET_CARD_SITE_SCOPE = {
  error: 'Only an operator with access to every site changes a fleet RFID card',
  code: 'FORBIDDEN',
} as const;

const FLEET_CARD_PERMISSION = {
  error: 'Changing fleet RFID cards needs the fleetCards:write permission',
  code: 'INSUFFICIENT_PERMISSIONS',
} as const;

/**
 * Fleet RFID cards are a feature permission on this shared route: a card's
 * fleet, its monthly limit and every write of a card that has a fleet need
 * fleetCards:write on top of drivers:write. True when the reply was sent; the
 * token service checks again on the locked row (fleetCardsWrite).
 */
async function refuseFleetCardPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  check: {
    tokenIds?: readonly string[] | undefined;
    fleetId?: string | null | undefined;
    monthlyLimitCents?: number | null | undefined;
  },
): Promise<boolean> {
  if (await requestHasPermission(request, 'fleetCards:write')) return false;
  const fieldSet = check.fleetId != null || check.monthlyLimitCents != null;
  if (!fieldSet && !(await tokenService.anyFleetCard(check.tokenIds ?? []))) return false;
  await reply.status(403).send(FLEET_CARD_PERMISSION);
  return true;
}

/**
 * Fleet cards span every site: a site-restricted operator writes none of them,
 * whatever it changes. True when the reply was sent; the token service checks
 * again on the locked row.
 */
async function refuseFleetCardWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  tokenId: string,
  fleetId?: string | null,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (await isAllSiteUser(userId)) return false;
  const current = fleetId != null ? null : await tokenService.getToken(tokenId);
  if (fleetId == null && current?.fleetId == null) return false;
  await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
  return true;
}

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
              .loose(),
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
          'Every token matching the same filters as the list (search, tokenType, status), as CSV with the columns idToken, tokenType, driverEmail, isActive, expiresAt and label. The import reads the same columns; label may be left out.',
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
              .loose(),
          ),
          403: errorWith(
            'A site-restricted operator named a fleet RFID card, or a caller without fleetCards:write did',
            [ERROR_CODES.FORBIDDEN, ERROR_CODES.INSUFFICIENT_PERMISSIONS],
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
      if (await refuseFleetCardPermission(request, reply, { tokenIds: ids })) return;
      try {
        return await tokenService.bulkSetActive(
          ids,
          isActive,
          tokenService.tokenActorOf(getAuditActor(request)),
          { fleetCardsWrite: await requestHasPermission(request, 'fleetCards:write') },
        );
      } catch (err) {
        if (err instanceof tokenService.FleetCardSiteScopeError) {
          await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
          return;
        }
        if (err instanceof tokenService.FleetCardPermissionError) {
          await reply.status(403).send(FLEET_CARD_PERMISSION);
          return;
        }
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
        querystring: zodSchema(tokenSessionsQuery),
        response: {
          200: paginatedResponse(tokenSessionItem),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const { page, limit } = request.query as z.infer<typeof tokenSessionsQuery>;
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
            ...sessionChargingPointColumns,
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
          .leftJoin(sessionEvse, sessionEvseJoin)
          .leftJoin(sessionUnit, sessionUnitJoin)
          .leftJoin(sessionConnector, sessionConnectorJoin)
          .where(where)
          .orderBy(...sessionListSort.orderBy(request.query as z.infer<typeof tokenSessionsQuery>))
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
          400: errorWith('The driver is not an active member of the card fleet', [
            ERROR_CODES.FLEET_CARD_DRIVER_NOT_MEMBER,
          ]),
          403: errorWith(
            'A site-restricted operator named a fleet, or a caller without fleetCards:write set a fleet or a monthly limit or re-added a fleet card',
            [ERROR_CODES.FORBIDDEN, ERROR_CODES.INSUFFICIENT_PERMISSIONS],
          ),
          404: errorWith('Driver or fleet not found', [
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.FLEET_NOT_FOUND,
          ]),
          409: errorWith(
            "Duplicate token, inactive driver, a Plug and Charge contract token, another driver's vehicle id, a balance on a reactivated card that already holds one, or a fleet that does not bill on account",
            [
              ERROR_CODES.TOKEN_DUPLICATE,
              ERROR_CODES.DRIVER_INACTIVE,
              ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
              ERROR_CODES.VEHICLE_ID_IN_USE,
              ERROR_CODES.PREPAID_BALANCE_CONFLICT,
              ERROR_CODES.FLEET_CARD_NOT_BILLABLE,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const body = parseZodRequest(createTokenBody, request.body);
      // Fleet cards span every site: a site-restricted operator names no fleet.
      const { userId } = request.user as { userId: string };
      if (body.fleetId != null && !(await isAllSiteUser(userId))) {
        await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
        return;
      }
      if (await refuseFleetCardPermission(request, reply, body)) return;
      try {
        const token = await tokenService.createToken(
          body,
          tokenService.tokenActorOf(getAuditActor(request)),
          { fleetCardsWrite: await requestHasPermission(request, 'fleetCards:write') },
        );
        await reply.status(201).send(token);
      } catch (err) {
        // Re-adding a removed card of the driver reactivates it, and sets the
        // sent balance only while the card holds none (PP2 Info 3).
        if (err instanceof tokenService.PrepaidBalanceConflictError) {
          await reply.status(409).send({
            error: 'The card already holds a prepaid balance: change it on the token',
            code: 'PREPAID_BALANCE_CONFLICT',
          });
          return;
        }
        if (err instanceof tokenService.FleetCardSiteScopeError) {
          await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
          return;
        }
        if (err instanceof tokenService.FleetCardPermissionError) {
          await reply.status(403).send(FLEET_CARD_PERMISSION);
          return;
        }
        if (err instanceof tokenService.TokenFleetNotFoundError) {
          await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
          return;
        }
        if (err instanceof tokenService.FleetCardNotBillableError) {
          await reply.status(409).send({
            error: 'The fleet does not bill on account, so its RFID cards cannot charge',
            code: 'FLEET_CARD_NOT_BILLABLE',
          });
          return;
        }
        if (err instanceof tokenService.FleetCardDriverNotMemberError) {
          await reply.status(400).send({
            error: 'The driver is not an active member of the fleet',
            code: 'FLEET_CARD_DRIVER_NOT_MEMBER',
          });
          return;
        }
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
        if (err instanceof tokenService.VehicleIdTokenInUseError) {
          await reply.status(409).send({
            error: "Another driver's vehicle uses this id",
            code: 'VEHICLE_ID_IN_USE',
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
          400: errorWith(
            'prepaidBalanceCents without expectedPrepaidBalanceCents, or a fleet card given to a driver that is not an active member of the fleet',
            [ERROR_CODES.VALIDATION_ERROR, ERROR_CODES.FLEET_CARD_DRIVER_NOT_MEMBER],
          ),
          403: errorWith(
            'A site-restricted operator changed a fleet RFID card, or a caller without fleetCards:write did',
            [ERROR_CODES.FORBIDDEN, ERROR_CODES.INSUFFICIENT_PERMISSIONS],
          ),
          404: errorWith('Token, driver or fleet not found', [
            ERROR_CODES.TOKEN_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.FLEET_NOT_FOUND,
          ]),
          409: errorWith(
            'Duplicate token, inactive driver, a Plug and Charge contract token, a vehicle id in use, a stale expectedPrepaidBalanceCents, or a fleet that does not bill on account',
            [
              ERROR_CODES.TOKEN_DUPLICATE,
              ERROR_CODES.DRIVER_INACTIVE,
              ERROR_CODES.PNC_CONTRACT_TOKEN_LOCKED,
              ERROR_CODES.VEHICLE_ID_IN_USE,
              ERROR_CODES.PREPAID_BALANCE_CONFLICT,
              ERROR_CODES.FLEET_CARD_NOT_BILLABLE,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tokenParams>;
      const body = parseZodRequest(updateTokenBody, request.body);
      if (await refuseFleetCardWrite(request, reply, id, body.fleetId)) return;
      if (
        await refuseFleetCardPermission(request, reply, {
          tokenIds: [id],
          fleetId: body.fleetId,
          monthlyLimitCents: body.monthlyLimitCents,
        })
      ) {
        return;
      }
      try {
        const token = await tokenService.updateToken(
          id,
          body,
          tokenService.tokenActorOf(getAuditActor(request)),
          { fleetCardsWrite: await requestHasPermission(request, 'fleetCards:write') },
        );
        if (token == null) {
          await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
          return;
        }
        return token;
      } catch (err) {
        if (err instanceof tokenService.FleetCardSiteScopeError) {
          await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
          return;
        }
        if (err instanceof tokenService.FleetCardPermissionError) {
          await reply.status(403).send(FLEET_CARD_PERMISSION);
          return;
        }
        if (err instanceof tokenService.TokenFleetNotFoundError) {
          await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
          return;
        }
        if (err instanceof tokenService.FleetCardNotBillableError) {
          await reply.status(409).send({
            error: 'The fleet does not bill on account, so its RFID cards cannot charge',
            code: 'FLEET_CARD_NOT_BILLABLE',
          });
          return;
        }
        if (err instanceof tokenService.FleetCardDriverNotMemberError) {
          await reply.status(400).send({
            error: 'The driver is not an active member of the fleet',
            code: 'FLEET_CARD_DRIVER_NOT_MEMBER',
          });
          return;
        }
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
        if (err instanceof tokenService.PrepaidBalanceExpectedError) {
          await reply.status(400).send({
            error: 'expectedPrepaidBalanceCents is required with prepaidBalanceCents',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        if (err instanceof tokenService.PrepaidBalanceConflictError) {
          await reply.status(409).send({
            error: 'The prepaid balance changed since it was read',
            code: 'PREPAID_BALANCE_CONFLICT',
          });
          return;
        }
        if (err instanceof tokenService.VehicleIdTokenInUseError) {
          await reply.status(409).send({
            error: "Another driver's vehicle uses this id",
            code: 'VEHICLE_ID_IN_USE',
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
          403: errorWith(
            'A site-restricted operator deleted a fleet RFID card, or a caller without fleetCards:write did',
            [ERROR_CODES.FORBIDDEN, ERROR_CODES.INSUFFICIENT_PERMISSIONS],
          ),
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
      if (await refuseFleetCardWrite(request, reply, id)) return;
      if (await refuseFleetCardPermission(request, reply, { tokenIds: [id] })) return;

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
          { fleetCardsWrite: await requestHasPermission(request, 'fleetCards:write') },
        );
      } catch (err) {
        if (err instanceof tokenService.FleetCardSiteScopeError) {
          await reply.status(403).send(FLEET_CARD_SITE_SCOPE);
          return;
        }
        if (err instanceof tokenService.FleetCardPermissionError) {
          await reply.status(403).send(FLEET_CARD_PERMISSION);
          return;
        }
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
