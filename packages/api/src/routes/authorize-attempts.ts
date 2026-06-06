// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, ilike, sql, desc, gte, lte } from 'drizzle-orm';
import { db, authorizeAttempts, chargingStations, chargingSessions } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import { paginatedResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';

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
        'charging_sessions.id when this attempt resulted in a charging session (correlated by matched token + start within 10 minutes of the attempt). Null when no session followed.',
      ),
    outcome: z.string().describe('Outcome enum'),
    ocppVersion: z.string().nullable().describe('OCPP protocol version of the request'),
    reason: z.string().nullable().describe('Short machine-readable reason tag'),
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
      } = request.query as z.infer<typeof listQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (stationId != null) conditions.push(eq(authorizeAttempts.stationId, stationId));
      if (idToken != null && idToken.trim() !== '') {
        conditions.push(ilike(authorizeAttempts.idToken, `%${idToken}%`));
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

      const where = conditions.length > 0 ? and(...conditions) : undefined;

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
              WHERE ${chargingSessions.tokenId} = ${authorizeAttempts.matchedTokenId}
                AND ${chargingSessions.startedAt} >= ${authorizeAttempts.createdAt}
                AND ${chargingSessions.startedAt} <= ${authorizeAttempts.createdAt} + interval '10 minutes'
              ORDER BY ${chargingSessions.startedAt} ASC
              LIMIT 1
            )`,
            outcome: authorizeAttempts.outcome,
            ocppVersion: authorizeAttempts.ocppVersion,
            reason: authorizeAttempts.reason,
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
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 };
    },
  );
}
