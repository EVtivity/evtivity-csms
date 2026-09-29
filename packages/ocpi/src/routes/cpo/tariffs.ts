// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { desc, gte, lte, sql } from 'drizzle-orm';
import { db, ocpiTariffMappings, getCompanyCurrency } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { tariffInCurrency } from '../../lib/tariff-currency.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function registerCpoTariffRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/tariffs - paginated OCPI tariffs
  app.get(
    `/ocpi/${version}/cpo/tariffs`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      // Per-partner isolation. ocpi_tariff_mappings.partner_id is nullable:
      // null = global (visible to all partners), non-null = scoped to that
      // partner. Without this filter every partner sees every other
      // partner's negotiated tariffs, leaking commercial terms across
      // networks. Mirrors the sessions/CDRs endpoints.
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        return ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated');
      }

      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [
        sql`(${ocpiTariffMappings.partnerId} IS NULL OR ${ocpiTariffMappings.partnerId} = ${partner.partnerId})`,
      ];
      if (dateFrom != null) {
        conditions.push(gte(ocpiTariffMappings.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lte(ocpiTariffMappings.updatedAt, dateTo));
      }

      const where = sql.join(conditions, sql` AND `);

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

      const currency = await getCompanyCurrency();
      const tariffs = rows.map((row) => tariffInCurrency(row.ocpiTariffData, currency));
      return ocpiSuccess(tariffs);
    },
  );
}

export function cpoTariffRoutes(app: FastifyInstance): void {
  registerCpoTariffRoutes(app, '2.2.1');
  registerCpoTariffRoutes(app, '2.3.0');
}
