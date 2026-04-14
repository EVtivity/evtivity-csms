// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, ocpiExternalLocations } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiLocation, OcpiEVSE } from '../../types/ocpi.js';

function registerEmspLocationRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/locations`;

  // GET /ocpi/{version}/emsp/locations/:country_code/:party_id/:location_id
  app.get(
    `${prefix}/:country_code/:party_id/:location_id`,
    { onRequest: [ocpiAuthenticate] },
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
    { onRequest: [ocpiAuthenticate] },
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
    { onRequest: [ocpiAuthenticate] },
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
    { onRequest: [ocpiAuthenticate] },
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

      const body = request.body as OcpiLocation | null;
      if (body == null || typeof body !== 'object') {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid location object'));
        return;
      }

      const evseCount = String(Array.isArray(body.evses) ? body.evses.length : 0);
      const latitude = body.coordinates.latitude;
      const longitude = body.coordinates.longitude;

      const [existing] = await db
        .select({ id: ocpiExternalLocations.id })
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

      if (existing != null) {
        await db
          .update(ocpiExternalLocations)
          .set({
            name: body.name ?? null,
            latitude,
            longitude,
            evseCount,
            locationData: body,
            updatedAt: new Date(),
          })
          .where(eq(ocpiExternalLocations.id, existing.id));
      } else {
        await db.insert(ocpiExternalLocations).values({
          partnerId: partner.partnerId,
          countryCode: country_code,
          partyId: party_id,
          locationId: location_id,
          name: body.name ?? null,
          latitude,
          longitude,
          evseCount,
          locationData: body,
        });
      }

      return ocpiSuccess(null);
    },
  );

  // PUT EVSE-level update
  app.put(
    `${prefix}/:country_code/:party_id/:location_id/:evse_uid`,
    { onRequest: [ocpiAuthenticate] },
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

      const evseBody = request.body as OcpiEVSE;

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
    { onRequest: [ocpiAuthenticate] },
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

      const connectorBody = request.body;

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
    { onRequest: [ocpiAuthenticate] },
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

      const patch = request.body as Record<string, unknown>;
      const currentData = existing.locationData as Record<string, unknown>;
      const mergedData = { ...currentData, ...patch } as unknown as OcpiLocation;

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
        const coords = patch['coordinates'] as { latitude?: string; longitude?: string };
        if (coords.latitude != null) updateFields.latitude = coords.latitude;
        if (coords.longitude != null) updateFields.longitude = coords.longitude;
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
    { onRequest: [ocpiAuthenticate] },
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

      const patch = request.body as Record<string, unknown>;
      const currentEvse = evses[evseIndex] as unknown as Record<string, unknown>;
      evses[evseIndex] = { ...currentEvse, ...patch } as unknown as OcpiEVSE;
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
    { onRequest: [ocpiAuthenticate] },
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

      const patch = request.body as Record<string, unknown>;
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
