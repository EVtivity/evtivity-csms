// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { desc, gte, lte, sql } from 'drizzle-orm';
import { db, ocpiRoamingSessions, ocpiCdrs } from '@evtivity/database';
import { ocpiSuccess } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiSession } from '../../types/ocpi.js';

function registerCpoSessionRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/sessions - paginated roaming sessions
  app.get(
    `/ocpi/${version}/cpo/sessions`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [];
      if (dateFrom != null) {
        conditions.push(gte(ocpiRoamingSessions.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lte(ocpiRoamingSessions.updatedAt, dateTo));
      }

      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(ocpiRoamingSessions)
          .where(where)
          .orderBy(desc(ocpiRoamingSessions.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiRoamingSessions)
          .where(where),
      ]);

      const total = countRows[0]?.count ?? 0;
      setPaginationHeaders(reply, request, total, limit, offset);

      // Return the session data stored in the sessionData JSONB column
      const sessions = rows.map((row) => row.sessionData as OcpiSession);
      return ocpiSuccess(sessions);
    },
  );
}

function registerCpoCdrRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/cdrs - paginated CDRs
  app.get(
    `/ocpi/${version}/cpo/cdrs`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [];
      if (dateFrom != null) {
        conditions.push(gte(ocpiCdrs.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lte(ocpiCdrs.updatedAt, dateTo));
      }

      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(ocpiCdrs)
          .where(where)
          .orderBy(desc(ocpiCdrs.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiCdrs)
          .where(where),
      ]);

      const total = countRows[0]?.count ?? 0;
      setPaginationHeaders(reply, request, total, limit, offset);

      const cdrs = rows.map((row) => row.cdrData);
      return ocpiSuccess(cdrs);
    },
  );
}

export function cpoSessionRoutes(app: FastifyInstance): void {
  registerCpoSessionRoutes(app, '2.2.1');
  registerCpoSessionRoutes(app, '2.3.0');
}

export function cpoCdrRoutes(app: FastifyInstance): void {
  registerCpoCdrRoutes(app, '2.2.1');
  registerCpoCdrRoutes(app, '2.3.0');
}
