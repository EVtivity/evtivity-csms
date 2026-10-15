// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db, ocpiExternalTariffs } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { ocpiParamLimits } from '../../middleware/ocpi-params.js';
import { namespaceMismatch } from '../../lib/namespace-check.js';
import {
  bodyIdentityMismatch,
  fitsOcpiString,
  patchChangesIdentity,
} from '../../lib/ocpi-fields.js';
import type { OcpiVersion, OcpiTariff } from '../../types/ocpi.js';

function isValidTariff(body: unknown): body is OcpiTariff {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string' &&
    fitsOcpiString(obj['currency'], 3) &&
    Array.isArray(obj['elements'])
  );
}

function registerEmspTariffRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/tariffs`;

  // GET /ocpi/{version}/emsp/tariffs/:country_code/:party_id/:tariff_id
  app.get(
    `${prefix}/:country_code/:party_id/:tariff_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, tariff_id } = request.params as {
        country_code: string;
        party_id: string;
        tariff_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [tariff] = await db
        .select()
        .from(ocpiExternalTariffs)
        .where(
          and(
            eq(ocpiExternalTariffs.partnerId, partner.partnerId),
            eq(ocpiExternalTariffs.countryCode, country_code),
            eq(ocpiExternalTariffs.partyId, party_id),
            eq(ocpiExternalTariffs.tariffId, tariff_id),
          ),
        )
        .limit(1);

      if (tariff == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Tariff not found'));
        return;
      }

      return ocpiSuccess(tariff.tariffData as OcpiTariff);
    },
  );

  // PUT /ocpi/{version}/emsp/tariffs/:country_code/:party_id/:tariff_id - upsert tariff
  app.put(
    `${prefix}/:country_code/:party_id/:tariff_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, tariff_id } = request.params as {
        country_code: string;
        party_id: string;
        tariff_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT tariff for another partner'));
        return;
      }

      const body = request.body;
      if (!isValidTariff(body)) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid tariff object'));
        return;
      }

      const mismatch = bodyIdentityMismatch(body as unknown as Record<string, unknown>, {
        id: tariff_id,
        country_code,
        party_id,
      });
      if (mismatch != null) {
        await reply
          .status(400)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_INVALID_PARAMS,
              `Tariff ${mismatch} does not match the URL`,
            ),
          );
        return;
      }

      // Upsert on the unique (partner, country, party, tariff id), so two
      // concurrent first PUTs store one row.
      await db
        .insert(ocpiExternalTariffs)
        .values({
          partnerId: partner.partnerId,
          countryCode: country_code,
          partyId: party_id,
          tariffId: tariff_id,
          currency: body.currency,
          tariffData: body,
        })
        .onConflictDoUpdate({
          target: [
            ocpiExternalTariffs.partnerId,
            ocpiExternalTariffs.countryCode,
            ocpiExternalTariffs.partyId,
            ocpiExternalTariffs.tariffId,
          ],
          set: {
            currency: sql`excluded.currency`,
            tariffData: sql`excluded.tariff_data`,
            updatedAt: sql`now()`,
          },
        });

      return ocpiSuccess(null);
    },
  );

  // PATCH /ocpi/{version}/emsp/tariffs/:country_code/:party_id/:tariff_id - partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:tariff_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, tariff_id } = request.params as {
        country_code: string;
        party_id: string;
        tariff_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH tariff for another partner'));
        return;
      }

      const rawPatch = request.body;
      if (rawPatch == null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'PATCH body must be a JSON object'),
          );
        return;
      }

      const [existing] = await db
        .select()
        .from(ocpiExternalTariffs)
        .where(
          and(
            eq(ocpiExternalTariffs.partnerId, partner.partnerId),
            eq(ocpiExternalTariffs.countryCode, country_code),
            eq(ocpiExternalTariffs.partyId, party_id),
            eq(ocpiExternalTariffs.tariffId, tariff_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Tariff not found'));
        return;
      }

      const patch = rawPatch as Record<string, unknown>;
      const identity = patchChangesIdentity(patch, { id: tariff_id, country_code, party_id }, [
        'id',
        'country_code',
        'party_id',
      ]);
      if (identity != null) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, `Cannot change ${identity}`));
        return;
      }
      if (patch['currency'] != null && !fitsOcpiString(patch['currency'], 3)) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid currency'));
        return;
      }
      if (patch['elements'] != null && !Array.isArray(patch['elements'])) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid elements'));
        return;
      }
      const currentData = existing.tariffData as Record<string, unknown>;
      const mergedData = { ...currentData, ...patch };

      const updateFields: {
        tariffData: Record<string, unknown>;
        updatedAt: Date;
        currency?: string;
      } = {
        tariffData: mergedData,
        updatedAt: new Date(),
      };

      if (typeof patch['currency'] === 'string') {
        updateFields.currency = patch['currency'];
      }

      await db
        .update(ocpiExternalTariffs)
        .set(updateFields)
        .where(eq(ocpiExternalTariffs.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // DELETE /ocpi/{version}/emsp/tariffs/:country_code/:party_id/:tariff_id
  app.delete(
    `${prefix}/:country_code/:party_id/:tariff_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, tariff_id } = request.params as {
        country_code: string;
        party_id: string;
        tariff_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot DELETE tariff for another partner'));
        return;
      }

      const [existing] = await db
        .select({ id: ocpiExternalTariffs.id })
        .from(ocpiExternalTariffs)
        .where(
          and(
            eq(ocpiExternalTariffs.partnerId, partner.partnerId),
            eq(ocpiExternalTariffs.countryCode, country_code),
            eq(ocpiExternalTariffs.partyId, party_id),
            eq(ocpiExternalTariffs.tariffId, tariff_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Tariff not found'));
        return;
      }

      await db.delete(ocpiExternalTariffs).where(eq(ocpiExternalTariffs.id, existing.id));

      return ocpiSuccess(null);
    },
  );
}

export function emspTariffRoutes(app: FastifyInstance): void {
  registerEmspTariffRoutes(app, '2.2.1');
  registerEmspTariffRoutes(app, '2.3.0');
}
