// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, ocpiCdrs } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { config } from '../../lib/config.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiCdr } from '../../types/ocpi.js';

function isValidCdr(body: unknown): body is OcpiCdr {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string' &&
    typeof obj['start_date_time'] === 'string' &&
    typeof obj['end_date_time'] === 'string' &&
    typeof obj['currency'] === 'string' &&
    typeof obj['total_energy'] === 'number' &&
    obj['total_cost'] != null
  );
}

function registerEmspCdrRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/cdrs`;

  // GET /ocpi/{version}/emsp/cdrs/:cdr_id - get a specific CDR
  app.get(`${prefix}/:cdr_id`, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const { cdr_id } = request.params as { cdr_id: string };

    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const [cdr] = await db
      .select()
      .from(ocpiCdrs)
      .where(and(eq(ocpiCdrs.partnerId, partner.partnerId), eq(ocpiCdrs.ocpiCdrId, cdr_id)))
      .limit(1);

    if (cdr == null) {
      await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'CDR not found'));
      return;
    }

    return ocpiSuccess(cdr.cdrData as OcpiCdr);
  });

  // POST /ocpi/{version}/emsp/cdrs - receive a new CDR from CPO
  app.post(prefix, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const body = request.body;
    if (!isValidCdr(body)) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid CDR object'));
      return;
    }

    // Check for duplicate CDR
    const [existing] = await db
      .select({ id: ocpiCdrs.id })
      .from(ocpiCdrs)
      .where(and(eq(ocpiCdrs.partnerId, partner.partnerId), eq(ocpiCdrs.ocpiCdrId, body.id)))
      .limit(1);

    if (existing != null) {
      await reply.status(409).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'CDR already exists'));
      return;
    }

    const totalCost = typeof body.total_cost === 'object' ? String(body.total_cost.excl_vat) : '0';

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
      .returning({ id: ocpiCdrs.id });

    // Return Location header with the CDR URL per OCPI spec
    const baseUrl = config.OCPI_BASE_URL;
    const cdrUrl = `${baseUrl}/ocpi/${version}/emsp/cdrs/${body.id}`;
    void reply.header('Location', cdrUrl);

    if (inserted == null) {
      await reply.status(500).send(ocpiError(OcpiStatusCode.SERVER_ERROR, 'Failed to store CDR'));
      return;
    }

    return ocpiSuccess(null);
  });
}

export function emspCdrRoutes(app: FastifyInstance): void {
  registerEmspCdrRoutes(app, '2.2.1');
  registerEmspCdrRoutes(app, '2.3.0');
}
