// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { db, ocpiRoamingSessions } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { ocpiParamLimits } from '../../middleware/ocpi-params.js';
import { namespaceMismatch } from '../../lib/namespace-check.js';
import { notifyRoamingSessionChanged } from '../../lib/pubsub.js';
import { priceExclTax } from '../../lib/ocpi-price.js';
import {
  bodyIdentityMismatch,
  fitsOcpiString,
  patchChangesIdentity,
} from '../../lib/ocpi-fields.js';
import { receivedSessionUpdateAllowed } from '../../lib/received-session-order.js';
import type { OcpiVersion, OcpiSession } from '../../types/ocpi.js';

// total_cost is optional; when present it must be a Price of the route's
// version: excl_vat in 2.2.1, before_taxes in 2.3.0.
function isValidSession(body: unknown, version: OcpiVersion): body is OcpiSession {
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
    typeof obj['kwh'] === 'number' &&
    Number.isFinite(obj['kwh']) &&
    fitsOcpiString(obj['status'], 20) &&
    fitsOcpiString(obj['currency'], 3) &&
    cdrToken != null &&
    fitsOcpiString(cdrToken.uid, 36) &&
    (obj['total_cost'] == null || priceExclTax(obj['total_cost'], version) != null)
  );
}

// A PATCH cannot rename the session or move it to another party.
const SESSION_IDENTITY_FIELDS = ['id', 'country_code', 'party_id'] as const;

// Sessions the partner pushed to us as eMSP. Rows with a charging session are
// our own CPO sessions linked to the partner; the receiver never reads or
// writes those.
function receivedSession(partnerId: string, sessionId: string) {
  return and(
    eq(ocpiRoamingSessions.partnerId, partnerId),
    eq(ocpiRoamingSessions.ocpiSessionId, sessionId),
    isNull(ocpiRoamingSessions.chargingSessionId),
  );
}

interface SessionColumns {
  status: string;
  kwh: string;
  totalCost: string | null;
  currency: string;
  sessionData: OcpiSession;
}

/**
 * Upsert a received session under the row lock, applying the ordering guard.
 * Returns false when the stored session is newer (the update is ignored).
 */
async function upsertReceivedSession(
  partnerId: string,
  sessionId: string,
  tokenUid: string,
  columns: SessionColumns,
): Promise<boolean> {
  // Two attempts: an insert that loses the race against a concurrent first
  // PUT of the same session finds the row on the second pass.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await db.transaction(async (tx): Promise<'applied' | 'stale' | 'retry'> => {
      const [existing] = await tx
        .select({ id: ocpiRoamingSessions.id, sessionData: ocpiRoamingSessions.sessionData })
        .from(ocpiRoamingSessions)
        .where(receivedSession(partnerId, sessionId))
        .for('update')
        .limit(1);

      if (existing != null) {
        if (
          !receivedSessionUpdateAllowed(
            existing.sessionData as Record<string, unknown>,
            columns.sessionData as unknown as Record<string, unknown>,
          )
        ) {
          return 'stale';
        }
        await tx
          .update(ocpiRoamingSessions)
          .set({ ...columns, updatedAt: new Date() })
          .where(eq(ocpiRoamingSessions.id, existing.id));
        return 'applied';
      }

      const inserted = await tx
        .insert(ocpiRoamingSessions)
        .values({ partnerId, ocpiSessionId: sessionId, tokenUid, ...columns })
        .onConflictDoNothing({
          target: [ocpiRoamingSessions.partnerId, ocpiRoamingSessions.ocpiSessionId],
          where: isNull(ocpiRoamingSessions.chargingSessionId),
        })
        .returning({ id: ocpiRoamingSessions.id });
      return inserted.length > 0 ? 'applied' : 'retry';
    });
    if (outcome !== 'retry') return outcome === 'applied';
  }
  throw new Error('Received session upsert did not settle');
}

function registerEmspSessionRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/sessions`;

  // GET /ocpi/{version}/emsp/sessions/:country_code/:party_id/:session_id
  app.get(
    `${prefix}/:country_code/:party_id/:session_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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
        .where(receivedSession(partner.partnerId, session_id))
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
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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
      if (!isValidSession(body, version)) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid session object'));
        return;
      }

      const mismatch = bodyIdentityMismatch(body as unknown as Record<string, unknown>, {
        id: session_id,
        country_code,
        party_id,
      });
      if (mismatch != null) {
        await reply
          .status(400)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_INVALID_PARAMS,
              `Session ${mismatch} does not match the URL`,
            ),
          );
        return;
      }

      // ocpi_roaming_sessions.total_cost holds the amount excluding tax.
      const exclTax = priceExclTax(body.total_cost, version);
      const applied = await upsertReceivedSession(
        partner.partnerId,
        session_id,
        body.cdr_token.uid,
        {
          status: body.status,
          kwh: String(body.kwh),
          totalCost: exclTax != null ? String(exclTax) : null,
          currency: body.currency,
          sessionData: body,
        },
      );

      if (!applied) {
        request.log.info(
          { partnerId: partner.partnerId, sessionId: session_id },
          'Ignored a received session older than the stored one',
        );
        return ocpiSuccess(null);
      }

      // Tell the CSMS so the Roaming Sessions page reloads itself.
      notifyRoamingSessionChanged();

      return ocpiSuccess(null);
    },
  );

  // PATCH /ocpi/{version}/emsp/sessions/:country_code/:party_id/:session_id - partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:session_id`,
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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
      if (rawPatch == null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'PATCH body must be a JSON object'),
          );
        return;
      }
      const patch = rawPatch as Record<string, unknown>;

      const identity = patchChangesIdentity(
        patch,
        { id: session_id, country_code, party_id },
        SESSION_IDENTITY_FIELDS,
      );
      if (identity != null) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, `Cannot change ${identity}`));
        return;
      }

      const updateFields: {
        sessionData?: OcpiSession;
        updatedAt: Date;
        status?: string;
        kwh?: string;
        totalCost?: string | null;
        currency?: string;
      } = { updatedAt: new Date() };

      if (patch['status'] != null) {
        if (!fitsOcpiString(patch['status'], 20)) {
          await reply
            .status(400)
            .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid status'));
          return;
        }
        updateFields.status = patch['status'];
      }
      if (typeof patch['kwh'] === 'number') {
        updateFields.kwh = String(patch['kwh']);
      }
      if (patch['total_cost'] != null) {
        const exclTax = priceExclTax(patch['total_cost'], version);
        if (exclTax == null) {
          await reply
            .status(400)
            .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid total_cost'));
          return;
        }
        updateFields.totalCost = String(exclTax);
      }
      if (patch['currency'] != null) {
        if (!fitsOcpiString(patch['currency'], 3)) {
          await reply
            .status(400)
            .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid currency'));
          return;
        }
        updateFields.currency = patch['currency'];
      }

      const partnerId = partner.partnerId;
      const outcome = await db.transaction(
        async (tx): Promise<'not_found' | 'stale' | 'applied'> => {
          const [existing] = await tx
            .select({ id: ocpiRoamingSessions.id, sessionData: ocpiRoamingSessions.sessionData })
            .from(ocpiRoamingSessions)
            .where(receivedSession(partnerId, session_id))
            .for('update')
            .limit(1);
          if (existing == null) return 'not_found';

          const currentData = existing.sessionData as Record<string, unknown>;
          const mergedData = { ...currentData, ...patch };
          if (!receivedSessionUpdateAllowed(currentData, mergedData)) return 'stale';

          await tx
            .update(ocpiRoamingSessions)
            .set({ ...updateFields, sessionData: mergedData })
            .where(eq(ocpiRoamingSessions.id, existing.id));
          return 'applied';
        },
      );

      if (outcome === 'not_found') {
        await reply.status(404).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Session not found'));
        return;
      }
      if (outcome === 'stale') {
        request.log.info(
          { partnerId, sessionId: session_id },
          'Ignored a received session patch older than the stored session',
        );
        return ocpiSuccess(null);
      }

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
