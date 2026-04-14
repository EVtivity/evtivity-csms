// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, ocpiExternalTokens } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiToken, OcpiAuthorizationInfo } from '../../types/ocpi.js';

function isValidToken(body: unknown): body is OcpiToken {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['uid'] === 'string' &&
    typeof obj['type'] === 'string' &&
    typeof obj['contract_id'] === 'string' &&
    typeof obj['issuer'] === 'string' &&
    typeof obj['valid'] === 'boolean' &&
    typeof obj['whitelist'] === 'string' &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string'
  );
}

function registerCpoTokenRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/cpo/tokens`;

  // GET /ocpi/{version}/cpo/tokens/:country_code/:party_id/:token_uid - get stored token
  app.get(
    `${prefix}/:country_code/:party_id/:token_uid`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id, token_uid } = request.params as {
        country_code: string;
        party_id: string;
        token_uid: string;
      };

      const [token] = await db
        .select()
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.countryCode, country_code),
            eq(ocpiExternalTokens.partyId, party_id),
            eq(ocpiExternalTokens.uid, token_uid),
          ),
        )
        .limit(1);

      if (token == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_TOKEN, 'Token not found'));
        return;
      }

      return ocpiSuccess(token.tokenData as OcpiToken);
    },
  );

  // PUT /ocpi/{version}/cpo/tokens/:country_code/:party_id/:token_uid - upsert token
  app.put(
    `${prefix}/:country_code/:party_id/:token_uid`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id, token_uid } = request.params as {
        country_code: string;
        party_id: string;
        token_uid: string;
      };

      const body = request.body;
      if (!isValidToken(body)) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid token object'));
        return;
      }

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      // Upsert the token
      const existing = await db
        .select({ id: ocpiExternalTokens.id })
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.countryCode, country_code),
            eq(ocpiExternalTokens.partyId, party_id),
            eq(ocpiExternalTokens.uid, token_uid),
          ),
        )
        .limit(1);

      if (existing[0] != null) {
        await db
          .update(ocpiExternalTokens)
          .set({
            tokenType: body.type,
            isValid: body.valid,
            whitelist: body.whitelist,
            tokenData: body,
            updatedAt: new Date(),
          })
          .where(eq(ocpiExternalTokens.id, existing[0].id));
      } else {
        await db.insert(ocpiExternalTokens).values({
          partnerId: partner.partnerId,
          countryCode: country_code,
          partyId: party_id,
          uid: token_uid,
          tokenType: body.type,
          isValid: body.valid,
          whitelist: body.whitelist,
          tokenData: body,
        });
      }

      return ocpiSuccess(null);
    },
  );

  // PATCH /ocpi/{version}/cpo/tokens/:country_code/:party_id/:token_uid - partial update
  app.patch(
    `${prefix}/:country_code/:party_id/:token_uid`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id, token_uid } = request.params as {
        country_code: string;
        party_id: string;
        token_uid: string;
      };

      const [existing] = await db
        .select()
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.countryCode, country_code),
            eq(ocpiExternalTokens.partyId, party_id),
            eq(ocpiExternalTokens.uid, token_uid),
          ),
        )
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_TOKEN, 'Token not found'));
        return;
      }

      const patch = request.body as Record<string, unknown>;
      const currentData = existing.tokenData as Record<string, unknown>;
      const mergedData = { ...currentData, ...patch };

      const updateFields: Record<string, unknown> = {
        tokenData: mergedData,
        updatedAt: new Date(),
      };

      if (typeof patch['valid'] === 'boolean') {
        updateFields['isValid'] = patch['valid'];
      }
      if (typeof patch['whitelist'] === 'string') {
        updateFields['whitelist'] = patch['whitelist'];
      }
      if (typeof patch['type'] === 'string') {
        updateFields['tokenType'] = patch['type'];
      }

      await db
        .update(ocpiExternalTokens)
        .set(updateFields)
        .where(eq(ocpiExternalTokens.id, existing.id));

      return ocpiSuccess(null);
    },
  );

  // POST /ocpi/{version}/cpo/tokens/:token_uid/authorize - real-time authorization
  app.post(`${prefix}/:token_uid/authorize`, { onRequest: [ocpiAuthenticate] }, async (request) => {
    const { token_uid } = request.params as { token_uid: string };

    // Look up the token
    const [token] = await db
      .select()
      .from(ocpiExternalTokens)
      .where(eq(ocpiExternalTokens.uid, token_uid))
      .limit(1);

    if (token == null) {
      const result: OcpiAuthorizationInfo = {
        allowed: 'NOT_ALLOWED',
        token: {
          country_code: '',
          party_id: '',
          uid: token_uid,
          type: 'RFID',
          contract_id: token_uid,
          issuer: '',
          valid: false,
          whitelist: 'NEVER',
          last_updated: new Date().toISOString(),
        },
      };
      return ocpiSuccess(result);
    }

    const tokenData = token.tokenData as OcpiToken;
    const allowed = token.isValid ? 'ALLOWED' : 'BLOCKED';

    const body = request.body as Record<string, unknown> | null;
    const result: OcpiAuthorizationInfo = {
      allowed,
      token: tokenData,
    };

    if (body != null && typeof body['location_id'] === 'string') {
      result.location = {
        location_id: body['location_id'],
      };
      const evseUids = body['evse_uids'];
      if (Array.isArray(evseUids)) {
        result.location.evse_uids = evseUids as string[];
      }
    }

    return ocpiSuccess(result);
  });
}

export function cpoTokenRoutes(app: FastifyInstance): void {
  registerCpoTokenRoutes(app, '2.2.1');
  registerCpoTokenRoutes(app, '2.3.0');
}
