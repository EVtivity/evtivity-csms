// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, ocpiRoamingSessions } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { namespaceMismatch } from '../../lib/namespace-check.js';
import { notifyRoamingSessionChanged } from '../../lib/pubsub.js';
import type { OcpiVersion, OcpiSession } from '../../types/ocpi.js';

function isValidSession(body: unknown): body is OcpiSession {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  // cdr_token is required at the wire level (we read body.cdr_token.uid on
  // insert). Without this check a PUT with no cdr_token crashes with
  // "Cannot read properties of undefined" deep in the handler.
  const cdrToken = obj['cdr_token'] as { uid?: unknown } | undefined;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string' &&
    typeof obj['start_date_time'] === 'string' &&
    typeof obj['status'] === 'string' &&
    typeof obj['currency'] === 'string' &&
    cdrToken != null &&
    typeof cdrToken.uid === 'string'
  );
}

function registerEmspSessionRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/sessions`;

  // GET /ocpi/{version}/emsp/sessions/:country_code/:party_id/:session_id
  app.get(
    `${prefix}/:country_code/:party_id/:session_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { session_id } = request.params as {
        country_code: string;
        party_id: string;
        session_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [session] = await db
        .select()
        .from(ocpiRoamingSessions)
        .where(
          and(
            eq(ocpiRoamingSessions.partnerId, partner.partnerId),
            eq(ocpiRoamingSessions.ocpiSessionId, session_id),
          ),
        )
        .limit(1);

      if (session == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Session not found'));
        return;
      }

      return ocpiSuccess(session.sessionData as OcpiSession);
    },
  );

  // PUT /ocpi/{version}/emsp/sessions/:country_code/:party_id/:session_id - upsert session
  app.put(
    `${prefix}/:country_code/:party_id/:session_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id, session_id } = request.params as {
        country_code: string;
        party_id: string;
        session_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT session for another partner'));
        return;
      }

      const body = request.body;
      if (!isValidSession(body)) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid session object'));
        return;
      }

      const tokenUid = body.cdr_token.uid;
      const kwh = String(body.kwh);
      const totalCost = body.total_cost != null ? String(body.total_cost.excl_vat) : null;
      const currency = body.currency;

      const [existing] = await db
        .select({ id: ocpiRoamingSessions.id })
        .from(ocpiRoamingSessions)
        .where(
          and(
            eq(ocpiRoamingSessions.partnerId, partner.partnerId),
            eq(ocpiRoamingSessions.ocpiSessionId, session_id),
          ),
        )
        .limit(1);

      if (existing != null) {
        await db
          .update(ocpiRoamingSessions)
          .set({
            status: body.status,
            kwh,
            totalCost,
            currency,
            sessionData: body,
            updatedAt: new Date(),
          })
          .where(eq(ocpiRoamingSessions.id, existing.id));
      } else {
        await db.insert(ocpiRoamingSessions).values({
          partnerId: partner.partnerId,
          ocpiSessionId: session_id,
          tokenUid,
          status: body.status,
          kwh,
          totalCost,
          currency,
          sessionData: body,
        });
      }

      // Tell the CSMS so the Roaming Sessions page reloads itself.
      notifyRoamingSessionChanged();

      return ocpiSuccess(null);
    },
  );

  // PATCH /ocpi/{version}/emsp/sessions/:country_code/:party_id/:session_id - partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:session_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id, session_id } = request.params as {
        country_code: string;
        party_id: string;
        session_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      if (namespaceMismatch(partner, country_code, party_id)) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH session for another partner'));
        return;
      }

      const rawPatch = request.body;
      if (rawPatch == null || typeof rawPatch !== 'object') {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'PATCH body must be a JSON object'),
          );
        return;
      }

      const [existing] = await db
        .select()
        .from(ocpiRoamingSessions)
        .where(
          and(
            eq(ocpiRoamingSessions.partnerId, partner.partnerId),
            eq(ocpiRoamingSessions.ocpiSessionId, session_id),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Session not found'));
        return;
      }

      const patch = rawPatch as Record<string, unknown>;
      const currentData = existing.sessionData as Record<string, unknown>;
      const mergedData = { ...currentData, ...patch } as unknown as OcpiSession;

      const updateFields: {
        sessionData: OcpiSession;
        updatedAt: Date;
        status?: string;
        kwh?: string;
        totalCost?: string | null;
        currency?: string;
      } = {
        sessionData: mergedData,
        updatedAt: new Date(),
      };

      if (typeof patch['status'] === 'string') {
        updateFields.status = patch['status'];
      }
      if (typeof patch['kwh'] === 'number') {
        updateFields.kwh = String(patch['kwh']);
      }
      if (patch['total_cost'] != null) {
        const cost = patch['total_cost'] as { excl_vat: number };
        updateFields.totalCost = String(cost.excl_vat);
      }
      if (typeof patch['currency'] === 'string') {
        updateFields.currency = patch['currency'];
      }

      await db
        .update(ocpiRoamingSessions)
        .set(updateFields)
        .where(eq(ocpiRoamingSessions.id, existing.id));

      // Tell the CSMS so the Roaming Sessions page reloads itself.
      notifyRoamingSessionChanged();

      return ocpiSuccess(null);
    },
  );
}

export function emspSessionRoutes(app: FastifyInstance): void {
  registerEmspSessionRoutes(app, '2.2.1');
  registerEmspSessionRoutes(app, '2.3.0');
}
