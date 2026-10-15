// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { db, ocpiCdrs } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { config } from '../../lib/config.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { ocpiParamLimits } from '../../middleware/ocpi-params.js';
import { fitsOcpiString } from '../../lib/ocpi-fields.js';
import { namespaceMismatch } from '../../lib/namespace-check.js';
import { notifyRoamingCdrChanged } from '../../lib/pubsub.js';
import { priceExclTax } from '../../lib/ocpi-price.js';
import type { OcpiVersion, OcpiCdr } from '../../types/ocpi.js';

// total_cost must be a Price of the route's version: excl_vat in 2.2.1,
// before_taxes in 2.3.0 (the amount stored in ocpi_cdrs.total_cost).
function isValidCdr(body: unknown, version: OcpiVersion): body is OcpiCdr {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    fitsOcpiString(obj['id'], 36) &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string' &&
    typeof obj['start_date_time'] === 'string' &&
    typeof obj['end_date_time'] === 'string' &&
    fitsOcpiString(obj['currency'], 3) &&
    typeof obj['total_energy'] === 'number' &&
    Number.isFinite(obj['total_energy']) &&
    priceExclTax(obj['total_cost'], version) != null
  );
}

function registerEmspCdrRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/cdrs`;

  // GET /ocpi/{version}/emsp/cdrs/:cdr_id - get a specific CDR
  app.get(
    `${prefix}/:cdr_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { cdr_id } = request.params as { cdr_id: string };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [cdr] = await db
        .select()
        .from(ocpiCdrs)
        .where(
          and(
            eq(ocpiCdrs.partnerId, partner.partnerId),
            eq(ocpiCdrs.ocpiCdrId, cdr_id),
            // Received CDRs only: rows with a charging session are our own CDRs
            // sent to this partner.
            isNull(ocpiCdrs.chargingSessionId),
          ),
        )
        .limit(1);

      if (cdr == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'CDR not found'));
        return;
      }

      return ocpiSuccess(cdr.cdrData as OcpiCdr);
    },
  );

  // POST /ocpi/{version}/emsp/cdrs - receive a new CDR from CPO
  app.post(prefix, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const body = request.body;
    if (!isValidCdr(body, version)) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid CDR object'));
      return;
    }

    // CDR POST has no URL country_code/party_id; the body itself names the
    // sending party. Per OCPI 2.2.1 §3.1.5 these MUST match the auth.
    if (namespaceMismatch(partner, body.country_code, body.party_id)) {
      await reply
        .status(403)
        .send(
          ocpiError(
            OcpiStatusCode.CLIENT_ERROR,
            'CDR country_code/party_id does not match credentials',
          ),
        );
      return;
    }

    const totalCost = String(priceExclTax(body.total_cost, version));

    // CDRs are immutable (OCPI 10.1): one row per partner and CDR id, kept by
    // the partial unique index uq_ocpi_cdrs_received, so two concurrent POSTs
    // of the same CDR store it once.
    const [inserted] = await db
      .insert(ocpiCdrs)
      .values({
        partnerId: partner.partnerId,
        ocpiCdrId: body.id,
        totalEnergy: String(body.total_energy),
        totalCost,
        currency: body.currency,
        cdrData: body,
        isCredit: body.credit === true,
        pushStatus: 'confirmed',
      })
      .onConflictDoNothing({
        target: [ocpiCdrs.partnerId, ocpiCdrs.ocpiCdrId],
        where: isNull(ocpiCdrs.chargingSessionId),
      })
      .returning({ id: ocpiCdrs.id });

    if (inserted == null) {
      await reply.status(409).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'CDR already exists'));
      return;
    }

    // Return Location header with the CDR URL per OCPI spec
    const baseUrl = config.OCPI_BASE_URL;
    const cdrUrl = `${baseUrl}/ocpi/${version}/emsp/cdrs/${encodeURIComponent(body.id)}`;
    void reply.header('Location', cdrUrl);

    // Tell the CSMS so the Roaming CDRs page reloads itself.
    notifyRoamingCdrChanged();

    return ocpiSuccess(null);
  });
}

export function emspCdrRoutes(app: FastifyInstance): void {
  registerEmspCdrRoutes(app, '2.2.1');
  registerEmspCdrRoutes(app, '2.3.0');
}
