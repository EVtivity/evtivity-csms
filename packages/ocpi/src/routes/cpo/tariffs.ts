// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { renderPartnerTariffs } from '../../services/published-tariffs.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function registerCpoTariffRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/cpo/tariffs - the tariffs published to the partner,
  // generated from the internal tariff or pricing group each mapping selects.
  // The Tariffs Sender interface only has this paginated list (§11.2.1).
  app.get(
    `/ocpi/${version}/cpo/tariffs`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      // Per-partner isolation: global mappings (partner_id null) plus the
      // partner's own. Without this every partner would see every other
      // partner's negotiated tariffs.
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        return ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated');
      }

      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      // last_updated is derived from the mapping, its source tariffs, and the
      // holidays, so the date filter applies to the rendered tariffs. A
      // partner has a handful of mappings, so they are rendered in memory.
      const all = (await renderPartnerTariffs(partner.partnerId, version)).filter((tariff) => {
        const updated = new Date(tariff.last_updated);
        if (dateFrom != null && updated < dateFrom) return false;
        if (dateTo != null && updated >= dateTo) return false;
        return true;
      });

      setPaginationHeaders(reply, request, all.length, limit, offset);
      return ocpiSuccess(all.slice(offset, offset + limit));
    },
  );
}

export function cpoTariffRoutes(app: FastifyInstance): void {
  registerCpoTariffRoutes(app, '2.2.1');
  registerCpoTariffRoutes(app, '2.3.0');
}
