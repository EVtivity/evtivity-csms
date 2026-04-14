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

const roamingSessionItem = z
  .object({
    id: z.string(),
    partnerId: z.string().nullable(),
    ocpiSessionId: z.string(),
    chargingSessionId: z.string().nullable(),
    tokenUid: z.string(),
    status: z.string(),
    kwh: z.string().nullable(),
    totalCost: z.string().nullable(),
    currency: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    partnerName: z.string().nullable(),
  })
  .passthrough();

const sessionQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
  status: z.string().optional().describe('Filter by session status'),
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
      if (status != null && status !== '') {
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
