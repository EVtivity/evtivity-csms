// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { desc, gte, lte, sql } from 'drizzle-orm';
import { db, driverTokens } from '@evtivity/database';
import { ocpiSuccess } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { config } from '../../lib/config.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { transformToken } from '../../transformers/token.transformer.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function registerEmspTokenRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/emsp/tokens - paginated list of our driver tokens in OCPI format
  app.get(
    `/ocpi/${version}/emsp/tokens`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [];
      if (dateFrom != null) {
        conditions.push(gte(driverTokens.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lte(driverTokens.updatedAt, dateTo));
      }

      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(driverTokens)
          .where(where)
          .orderBy(desc(driverTokens.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(driverTokens)
          .where(where),
      ]);

      const total = countRows[0]?.count ?? 0;
      setPaginationHeaders(reply, request, total, limit, offset);

      const countryCode = getCountryCode();
      const partyId = getPartyId();

      const tokens = rows.map((row) =>
        transformToken(
          {
            token: row,
            countryCode,
            partyId,
          },
          version,
        ),
      );

      return ocpiSuccess(tokens);
    },
  );
}

export function emspTokenRoutes(app: FastifyInstance): void {
  registerEmspTokenRoutes(app, '2.2.1');
  registerEmspTokenRoutes(app, '2.3.0');
}
