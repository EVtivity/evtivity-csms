// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { db, ocpiCdrs } from '@evtivity/database';
import { listPartnerCpoSessions } from '../../services/cpo-sessions.js';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function registerCpoSessionRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/sessions - our sessions as CPO for this partner:
  // charging sessions at our stations started with the partner's tokens,
  // rendered from the charging session (9.2.1.1). Sessions the partner sent
  // us as CPO (eMSP role, no charging session) are not ours to serve.
  app.get(
    `/ocpi/${version}/cpo/sessions`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      // Per-partner isolation: a partner only sees sessions of its own tokens.
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        return ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated');
      }

      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);
      const page: Parameters<typeof listPartnerCpoSessions>[2] = { offset, limit };
      if (dateFrom != null) page.dateFrom = dateFrom;
      if (dateTo != null) page.dateTo = dateTo;

      const { total, sessions } = await listPartnerCpoSessions(partner.partnerId, version, page);
      setPaginationHeaders(reply, request, total, limit, offset);
      return ocpiSuccess(sessions);
    },
  );
}

function registerCpoCdrRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/cdrs - the CDRs we issued as CPO to this partner
  // (and their credit CDRs). CDRs received from the partner as eMSP have no
  // charging session and are not ours to serve.
  app.get(
    `/ocpi/${version}/cpo/cdrs`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      // Per-partner isolation - see sessions endpoint above for rationale.
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        return ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated');
      }

      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const conditions = [
        eq(ocpiCdrs.partnerId, partner.partnerId),
        isNotNull(ocpiCdrs.chargingSessionId),
      ];
      // last_updated between date_from (inclusive) and date_to (exclusive).
      if (dateFrom != null) {
        conditions.push(gte(ocpiCdrs.updatedAt, dateFrom));
      }
      if (dateTo != null) {
        conditions.push(lt(ocpiCdrs.updatedAt, dateTo));
      }

      const where = sql.join(conditions, sql` AND `);

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
