// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db, ocpiExternalLocations } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { ocpiParamLimits } from '../../middleware/ocpi-params.js';
import { namespaceMismatch } from '../../lib/namespace-check.js';
import {
  bodyIdentityMismatch,
  fitsOcpiString,
  isOcpiGeoLocation,
  patchChangesIdentity,
} from '../../lib/ocpi-fields.js';
import type { OcpiVersion, OcpiLocation, OcpiEVSE } from '../../types/ocpi.js';

function invalid(message: string) {
  return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, message);
}

// An EVSE object with the fields the receiver reads: uid and connectors.
function isEvseShape(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const evse = value as Record<string, unknown>;
  return fitsOcpiString(evse['uid'], 36) && Array.isArray(evse['connectors']);
}

// A Location's checked fields (PUT, or the merged result of a PATCH):
// GeoLocation per OCPI 8.4.16 (the portal geo search casts the stored
// values), name at most 255 characters, evses an array of EVSE objects.
function locationProblem(location: Record<string, unknown>): string | null {
  if (!isOcpiGeoLocation(location['coordinates'])) return 'Invalid location coordinates';
  const name = location['name'];
  if (name != null && !fitsOcpiString(name, 255)) return 'Invalid location name';
  const evses = location['evses'];
  if (evses != null && (!Array.isArray(evses) || !evses.every(isEvseShape))) {
    return 'Invalid location evses';
  }
  return null;
}

function registerEmspLocationRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/locations`;

  // GET /ocpi/{version}/emsp/locations/:country_code/:party_id/:location_id
  app.get(
    `${prefix}/:country_code/:party_id/:location_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [location] = await db
        .select()
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (location == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      return ocpiSuccess(location.locationData as OcpiLocation);
    },
  );

  // GET with EVSE uid
  app.get(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [location] = await db
        .select()
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (location == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = location.locationData as OcpiLocation;
      const evse = locationData.evses?.find((e) => e.uid === evse_uid);
      if (evse == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      return ocpiSuccess(evse);
    },
  );

  // GET with connector id
  app.get(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid/:connector_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid, connector_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
        connector_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [location] = await db
        .select()
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (location == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = location.locationData as OcpiLocation;
      const evse = locationData.evses?.find((e) => e.uid === evse_uid);
      if (evse == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const connector = evse.connectors.find((c) => c.id === connector_id);
      if (connector == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      return ocpiSuccess(connector);
    },
  );

  // PUT /ocpi/{version}/emsp/locations/:country_code/:party_id/:location_id - upsert location
  app.put(
    `${prefix}/:country_code/:party_id/:location_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT location for another partner'));
        return;
      }

      const rawBody = request.body;
      if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        await reply.status(400).send(invalid('Invalid location object'));
        return;
      }
      const candidate = rawBody as Record<string, unknown>;
      const mismatch = bodyIdentityMismatch(candidate, {
        id: location_id,
        country_code,
        party_id,
      });
      if (mismatch != null) {
        await reply.status(400).send(invalid(`Location ${mismatch} does not match the URL`));
        return;
      }
      const problem = locationProblem(candidate);
      if (problem != null) {
        await reply.status(400).send(invalid(problem));
        return;
      }
      const body = rawBody as OcpiLocation;

      const evseCount = String(Array.isArray(body.evses) ? body.evses.length : 0);

      // Upsert on the unique (partner, country, party, location id), so two
      // concurrent first PUTs store one row.
      await db
        .insert(ocpiExternalLocations)
        .values({
          partnerId: partner.partnerId,
          countryCode: country_code,
          partyId: party_id,
          locationId: location_id,
          name: body.name ?? null,
          latitude: body.coordinates.latitude,
          longitude: body.coordinates.longitude,
          evseCount,
          locationData: body,
        })
        .onConflictDoUpdate({
          target: [
            ocpiExternalLocations.partnerId,
            ocpiExternalLocations.countryCode,
            ocpiExternalLocations.partyId,
            ocpiExternalLocations.locationId,
          ],
          set: {
            name: sql`excluded.name`,
            latitude: sql`excluded.latitude`,
            longitude: sql`excluded.longitude`,
            evseCount: sql`excluded.evse_count`,
            locationData: sql`excluded.location_data`,
            updatedAt: sql`now()`,
          },
        });

      return ocpiSuccess(null);
    },
  );

  // PUT EVSE-level update
  app.put(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT EVSE for another partner'));
        return;
      }

      const rawEvse = request.body;
      if (!isEvseShape(rawEvse)) {
        await reply.status(400).send(invalid('Invalid EVSE object'));
        return;
      }
      if ((rawEvse as Record<string, unknown>)['uid'] !== evse_uid) {
        await reply.status(400).send(invalid('EVSE uid does not match the URL'));
        return;
      }
      const evseBody = rawEvse as OcpiEVSE;

      const [existing] = await db
        .select()
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = existing.locationData as OcpiLocation;
      const evses = locationData.evses ?? [];
      const evseIndex = evses.findIndex((e) => e.uid === evse_uid);
      if (evseIndex >= 0) {
        evses[evseIndex] = evseBody;
      } else {
        evses.push(evseBody);
      }
      locationData.evses = evses;

      await db
        .update(ocpiExternalLocations)
        .set({
          evseCount: String(evses.length),
          locationData,
          updatedAt: new Date(),
        })
        .where(eq(ocpiExternalLocations.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // PUT connector-level update
  app.put(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid/:connector_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid, connector_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
        connector_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT connector for another partner'));
        return;
      }

      const connectorBody = request.body;
      if (
        connectorBody == null ||
        typeof connectorBody !== 'object' ||
        Array.isArray(connectorBody)
      ) {
        await reply.status(400).send(invalid('Invalid connector object'));
        return;
      }
      if ((connectorBody as Record<string, unknown>)['id'] !== connector_id) {
        await reply.status(400).send(invalid('Connector id does not match the URL'));
        return;
      }

      const [existing] = await db
        .select()
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = existing.locationData as OcpiLocation;
      const evse = locationData.evses?.find((e) => e.uid === evse_uid);
      if (evse == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const connIndex = evse.connectors.findIndex((c) => c.id === connector_id);
      if (connIndex >= 0) {
        evse.connectors[connIndex] = connectorBody as (typeof evse.connectors)[number];
      } else {
        evse.connectors.push(connectorBody as (typeof evse.connectors)[number]);
      }

      await db
        .update(ocpiExternalLocations)
        .set({
          locationData,
          updatedAt: new Date(),
        })
        .where(eq(ocpiExternalLocations.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // PATCH location-level partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:location_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH location for another partner'),
          );
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
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const patch = rawPatch as Record<string, unknown>;
      const currentData = existing.locationData as Record<string, unknown>;
      const identity = patchChangesIdentity(patch, { id: location_id, country_code, party_id }, [
        'id',
        'country_code',
        'party_id',
      ]);
      if (identity != null) {
        await reply.status(400).send(invalid(`Cannot change ${identity}`));
        return;
      }
      const merged = { ...currentData, ...patch };
      const problem = locationProblem(merged);
      if (problem != null) {
        await reply.status(400).send(invalid(problem));
        return;
      }
      const mergedData = merged as unknown as OcpiLocation;

      const updateFields: {
        locationData: OcpiLocation;
        updatedAt: Date;
        name?: string | null;
        latitude?: string | null;
        longitude?: string | null;
        evseCount?: string;
      } = {
        locationData: mergedData,
        updatedAt: new Date(),
      };

      if (typeof patch['name'] === 'string') {
        updateFields.name = patch['name'];
      }
      if (patch['coordinates'] != null) {
        updateFields.latitude = mergedData.coordinates.latitude;
        updateFields.longitude = mergedData.coordinates.longitude;
      }
      if (Array.isArray(patch['evses'])) {
        updateFields.evseCount = String(patch['evses'].length);
      }

      await db
        .update(ocpiExternalLocations)
        .set(updateFields)
        .where(eq(ocpiExternalLocations.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // PATCH EVSE-level partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH EVSE for another partner'));
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
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = existing.locationData as OcpiLocation;
      const evses = locationData.evses ?? [];
      const evseIndex = evses.findIndex((e) => e.uid === evse_uid);
      if (evseIndex < 0) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const patch = rawPatch as Record<string, unknown>;
      const currentEvse = evses[evseIndex] as unknown as Record<string, unknown>;
      if (patchChangesIdentity(patch, { uid: evse_uid }, ['uid']) != null) {
        await reply.status(400).send(invalid('Cannot change uid'));
        return;
      }
      const mergedEvse = { ...currentEvse, ...patch };
      if (!isEvseShape(mergedEvse)) {
        await reply.status(400).send(invalid('Invalid EVSE object'));
        return;
      }
      evses[evseIndex] = mergedEvse as unknown as OcpiEVSE;
      locationData.evses = evses;

      await db
        .update(ocpiExternalLocations)
        .set({
          locationData,
          updatedAt: new Date(),
        })
        .where(eq(ocpiExternalLocations.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // PATCH connector-level partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid/:connector_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
    async (request, reply) => {
      const { country_code, party_id, location_id, evse_uid, connector_id } = request.params as {
        country_code: string;
        party_id: string;
        location_id: string;
        evse_uid: string;
        connector_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH connector for another partner'),
          );
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
        .from(ocpiExternalLocations)
        .where(
          and(
            eq(ocpiExternalLocations.partnerId, partner.partnerId),
            eq(ocpiExternalLocations.countryCode, country_code),
            eq(ocpiExternalLocations.partyId, party_id),
            eq(ocpiExternalLocations.locationId, location_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
        return;
      }

      const locationData = existing.locationData as OcpiLocation;
      const evse = locationData.evses?.find((e) => e.uid === evse_uid);
      if (evse == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const connIndex = evse.connectors.findIndex((c) => c.id === connector_id);
      if (connIndex < 0) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const patch = rawPatch as Record<string, unknown>;
      if (patchChangesIdentity(patch, { id: connector_id }, ['id']) != null) {
        await reply.status(400).send(invalid('Cannot change id'));
        return;
      }
      const currentConn = evse.connectors[connIndex] as unknown as Record<string, unknown>;
      evse.connectors[connIndex] = {
        ...currentConn,
        ...patch,
      } as unknown as (typeof evse.connectors)[number];

      await db
        .update(ocpiExternalLocations)
        .set({
          locationData,
          updatedAt: new Date(),
        })
        .where(eq(ocpiExternalLocations.id, existing.id));

      return ocpiSuccess(null);
    },
  );
}

export function emspLocationRoutes(app: FastifyInstance): void {
  registerEmspLocationRoutes(app, '2.2.1');
  registerEmspLocationRoutes(app, '2.3.0');
}
