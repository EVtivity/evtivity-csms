// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { desc, gte, lte, sql } from 'drizzle-orm';
import { db, ocpiTariffMappings } from '@evtivity/database';
import { ocpiSuccess } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiTariff } from '../../types/ocpi.js';

function registerCpoTariffRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/tariffs - paginated OCPI tariffs
  app.get(
    `/ocpi/${version}/cpo/tariffs`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [];
      if (dateFrom != null) {
        conditions.push(gte(ocpiTariffMappings.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lte(ocpiTariffMappings.updatedAt, dateTo));
      }

      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(ocpiTariffMappings)
          .where(where)
          .orderBy(desc(ocpiTariffMappings.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiTariffMappings)
          .where(where),
      ]);

      const total = countRows[0]?.count ?? 0;
      setPaginationHeaders(reply, request, total, limit, offset);

      const tariffs = rows.map((row) => row.ocpiTariffData as OcpiTariff);
      return ocpiSuccess(tariffs);
    },
  );
}

export function cpoTariffRoutes(app: FastifyInstance): void {
  registerCpoTariffRoutes(app, '2.2.1');
  registerCpoTariffRoutes(app, '2.3.0');
}
