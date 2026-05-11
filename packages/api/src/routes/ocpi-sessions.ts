// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and } from 'drizzle-orm';
import { db, ocpiRoamingSessions, ocpiPartners } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';

// OCPI roaming session status as stored in `ocpi_roaming_sessions.status`
// (lowercase). The session.transformer.ts maps these to OCPI 2.2.1 wire
// values (ACTIVE, COMPLETED, INVALID) when serializing for partners.
const OCPI_SESSION_STATUS = ['active', 'completed', 'invalid', 'faulted'] as const;

const roamingSessionItem = z
  .object({
    id: z.string().describe('Identifier'),
    partnerId: z.string().nullable().describe('OCPI partner ID, when known'),
    ocpiSessionId: z.string().describe('OCPI session identifier shared with the partner'),
    chargingSessionId: z
      .string()
      .nullable()
      .describe('Linked CSMS charging session ID, when this session maps to a local session'),
    tokenUid: z.string().describe('Driver token identifier used to start the session'),
    status: z.enum(OCPI_SESSION_STATUS).describe('Roaming session status'),
    kwh: z.string().nullable().describe('Total energy delivered in kWh, as a decimal string'),
    totalCost: z.string().nullable().describe('Total cost as a decimal string'),
    currency: z.string().nullable().describe('ISO 4217 currency code'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    partnerName: z.string().nullable().describe('Display name of the OCPI partner'),
  })
  .passthrough();

const sessionQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
  status: z.enum(OCPI_SESSION_STATUS).optional().describe('Filter by OCPI session status'),
});

export function ocpiSessionRoutes(app: FastifyInstance): void {
  // GET /ocpi/sessions - paginated roaming sessions
  app.get(
    '/ocpi/sessions',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI roaming sessions',
        operationId: 'listOcpiSessions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sessionQuery),
        response: { 200: paginatedResponse(roamingSessionItem) },
      },
    },
    async (request) => {
      const { page, limit, partnerId, status } = request.query as z.infer<typeof sessionQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (partnerId != null) {
        conditions.push(eq(ocpiRoamingSessions.partnerId, partnerId));
      }
      if (status != null) {
        conditions.push(eq(ocpiRoamingSessions.status, status));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: ocpiRoamingSessions.id,
            partnerId: ocpiRoamingSessions.partnerId,
            ocpiSessionId: ocpiRoamingSessions.ocpiSessionId,
            chargingSessionId: ocpiRoamingSessions.chargingSessionId,
            tokenUid: ocpiRoamingSessions.tokenUid,
            status: ocpiRoamingSessions.status,
            kwh: ocpiRoamingSessions.kwh,
            totalCost: ocpiRoamingSessions.totalCost,
            currency: ocpiRoamingSessions.currency,
            createdAt: ocpiRoamingSessions.createdAt,
            updatedAt: ocpiRoamingSessions.updatedAt,
            partnerName: ocpiPartners.name,
          })
          .from(ocpiRoamingSessions)
          .leftJoin(ocpiPartners, eq(ocpiRoamingSessions.partnerId, ocpiPartners.id))
          .where(where)
          .orderBy(desc(ocpiRoamingSessions.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiRoamingSessions)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
