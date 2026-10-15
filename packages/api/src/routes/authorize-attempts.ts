// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, sql, desc, gte, lte, inArray, isNull } from 'drizzle-orm';
import {
  db,
  authorizeAttempts,
  chargingStations,
  chargingSessions,
  isOperatorStation,
} from '@evtivity/database';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import { paginatedResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';

const OUTCOMES = [
  'accepted',
  'invalid',
  'blocked',
  'expired',
  'no_credit',
  'concurrent_tx',
  'unknown',
  'db_error',
] as const;

const attemptItem = z
  .object({
    id: z.number().describe('Attempt row identifier'),
    stationOcppId: z
      .string()
      .nullable()
      .describe('OCPP path identifier the station presented (e.g. CS-0001)'),
    stationDbId: z
      .string()
      .nullable()
      .describe('charging_stations.id for navigation to /stations/:id'),
    idToken: z.string().describe('Token value the station sent'),
    tokenType: z.string().nullable().describe('Token type (1.6 has no type)'),
    matchedTokenId: z.string().nullable().describe('driver_tokens.id of the matched row'),
    matchedDriverId: z
      .string()
      .nullable()
      .describe('drivers.id when the token resolved to a driver'),
    sessionId: z
      .string()
      .nullable()
      .describe(
        'charging_sessions.id when this attempt resulted in a charging session (correlated by matched token, the same station and a start within 10 minutes of the attempt). Null when no session followed.',
      ),
    outcome: z.string().describe('Outcome enum'),
    ocppVersion: z.string().nullable().describe('OCPP protocol version of the request'),
    reason: z.string().nullable().describe('Short machine-readable reason tag'),
    vehicleIdValue: z
      .string()
      .nullable()
      .describe(
        'Vehicle id the start carried (the token itself, a 2.1 additionalInfo entry or a vehicle-shaped 1.6 idTag), normalized; refused starts included',
      ),
    vehicleIdType: z
      .string()
      .nullable()
      .describe('Type of the vehicle id: VIN, EVCCID or MacAddress'),
    matchedVehicleId: z
      .string()
      .nullable()
      .describe('Autocharge vehicle that authorized or refused the start'),
    createdAt: z.coerce.date().describe('Timestamp of the attempt'),
  })
  .passthrough();

const listQuery = paginationQuery.extend({
  stationId: z
    .string()
    .optional()
    .describe('Filter by station OCPP path identifier (e.g. CS-0001)'),
  idToken: z.string().optional().describe('Partial match on idToken'),
  matchedTokenId: z
    .string()
    .optional()
    .describe('Filter by driver_tokens.id of the matched token row'),
  matchedDriverId: z.string().optional().describe('Filter by drivers.id of the matched driver row'),
  outcome: z.enum(OUTCOMES).optional().describe('Filter by outcome'),
  from: z.coerce.date().optional().describe('Earliest createdAt (inclusive)'),
  to: z.coerce.date().optional().describe('Latest createdAt (inclusive)'),
});

export function authorizeAttemptRoutes(app: FastifyInstance): void {
  app.get(
    '/authorize-attempts',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Tokens'],
        summary: 'List Authorize attempts (success and failure) for forensic triage',
        operationId: 'listAuthorizeAttempts',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 200: paginatedResponse(attemptItem) },
      },
    },
    async (request) => {
      const {
        page,
        limit,
        stationId,
        idToken,
        matchedTokenId,
        matchedDriverId,
        outcome,
        from,
        to,
      } = parseZodRequest(listQuery, request.query);
      const offset = (page - 1) * limit;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      // A site-restricted user sees attempts at stations of its sites only.
      // Attempts from an unknown or unsited station belong to no site and are
      // visible to all-site users only.
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };

      // Attempts at a conformance test station are never listed (an attempt
      // from an unknown station has no station row and stays).
      const conditions = [or(isNull(chargingStations.id), isOperatorStation())];
      if (siteIds != null) conditions.push(inArray(chargingStations.siteId, siteIds));
      if (stationId != null) conditions.push(eq(authorizeAttempts.stationId, stationId));
      if (idToken != null && idToken.trim() !== '') {
        // The token value, or the vehicle id a start carried (an EVCCID next
        // to a card, a VID: prefixed idTag in its normalized form).
        conditions.push(
          or(
            ilike(authorizeAttempts.idToken, `%${idToken}%`),
            ilike(authorizeAttempts.vehicleIdValue, `%${idToken}%`),
          ),
        );
      }
      if (matchedTokenId != null) {
        conditions.push(eq(authorizeAttempts.matchedTokenId, matchedTokenId));
      }
      if (matchedDriverId != null) {
        conditions.push(eq(authorizeAttempts.matchedDriverId, matchedDriverId));
      }
      if (outcome != null) conditions.push(eq(authorizeAttempts.outcome, outcome));
      if (from != null) conditions.push(gte(authorizeAttempts.createdAt, from));
      if (to != null) conditions.push(lte(authorizeAttempts.createdAt, to));

      const where = and(...conditions);

      // LEFT JOIN charging_stations on the OCPP path id so the UI can link
      // to /stations/:dbId. authorize_attempts.station_id stores the path
      // identifier the station presented (e.g. CS-0001), which is NOT the
      // same as charging_stations.id (`sta_*` nanoid).
      const [data, countRows] = await Promise.all([
        db
          .select({
            id: authorizeAttempts.id,
            stationOcppId: authorizeAttempts.stationId,
            stationDbId: chargingStations.id,
            idToken: authorizeAttempts.idToken,
            tokenType: authorizeAttempts.tokenType,
            matchedTokenId: authorizeAttempts.matchedTokenId,
            matchedDriverId: authorizeAttempts.matchedDriverId,
            sessionId: sql<string | null>`(
              SELECT ${chargingSessions.id} FROM ${chargingSessions}
              WHERE (${chargingSessions.tokenId} = ${authorizeAttempts.matchedTokenId}
                OR (${chargingSessions.autocharge}
                  AND ${chargingSessions.vehicleId} = ${authorizeAttempts.matchedVehicleId}))
                AND ${chargingSessions.startedAt} >= ${authorizeAttempts.createdAt}
                AND ${chargingSessions.startedAt} <= ${authorizeAttempts.createdAt} + interval '10 minutes'
                AND ${chargingSessions.stationId} = ${chargingStations.id}
              ORDER BY ${chargingSessions.startedAt} ASC
              LIMIT 1
            )`,
            outcome: authorizeAttempts.outcome,
            ocppVersion: authorizeAttempts.ocppVersion,
            reason: authorizeAttempts.reason,
            vehicleIdValue: authorizeAttempts.vehicleIdValue,
            vehicleIdType: authorizeAttempts.vehicleIdType,
            matchedVehicleId: authorizeAttempts.matchedVehicleId,
            createdAt: authorizeAttempts.createdAt,
          })
          .from(authorizeAttempts)
          .leftJoin(chargingStations, eq(chargingStations.stationId, authorizeAttempts.stationId))
          .where(where)
          .orderBy(desc(authorizeAttempts.createdAt), desc(authorizeAttempts.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(authorizeAttempts)
          .leftJoin(chargingStations, eq(chargingStations.stationId, authorizeAttempts.stationId))
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 };
    },
  );
}
