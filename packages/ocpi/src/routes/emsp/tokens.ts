// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { config } from '../../lib/config.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { transformToken } from '../../transformers/token.transformer.js';
import { listEmspTokens } from '../../services/emsp-tokens.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function registerEmspTokenRoutes(app: FastifyInstance, version: OcpiVersion): void {
  // GET /ocpi/{version}/emsp/tokens - paginated list of our driver tokens in OCPI format,
  // with deleted or renamed token values as valid = false (listEmspTokens)
  app.get(
    `/ocpi/${version}/emsp/tokens`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      if (request.ocpiPartner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);

      const { rows, total } = await listEmspTokens({
        offset,
        limit,
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
      });
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
