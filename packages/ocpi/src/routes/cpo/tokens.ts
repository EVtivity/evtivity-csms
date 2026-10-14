// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, ocpiExternalTokens, ocpiPartnerAuditLog, writeAudit } from '@evtivity/database';
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

/**
 * The `ocpi_partner.token_received` row of a token the partner pushed (PUT or
 * PATCH), on the pushing partner: actor `system`, label `ocpi-tokens`. Only
 * the token's identity and authorization fields, never the full token object.
 * Fail-open (writeAudit).
 */
async function auditTokenReceived(
  partnerId: string,
  log: FastifyBaseLogger,
  token: { uid: string; method: 'PUT' | 'PATCH'; created: boolean },
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(
    { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
    {
      entityId: partnerId,
      entityIdSnapshot: partnerId,
      action: 'token_received',
      actor: 'system',
      actorLabel: 'ocpi-tokens',
      before,
      after: { uid: token.uid, ...after },
      notes: `${token.method} token ${token.uid}${token.created ? ' (new)' : ''}`,
    },
    db,
    log,
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

      // Per-partner isolation: a token's (country_code, party_id) names the
      // eMSP that owns it. Without this guard any authenticated partner can
      // GET another partner's token data by guessing the party identifier.
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const [token] = await db
        .select()
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.partnerId, partner.partnerId),
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

      // A partner may only PUT tokens into its OWN (country_code, party_id)
      // namespace. Without this check, partner A authenticated with its own
      // token could PUT a row addressed to partner B's namespace; the
      // existing-row lookup below ignores partner_id, so partner A would
      // end up owning (or overwriting) partner B's token rows. Block at the
      // edge instead.
      if (partner.countryCode !== country_code || partner.partyId !== party_id) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PUT tokens for another partner'));
        return;
      }

      // Upsert the token. The lookup is scoped by partner_id so an attacker
      // who slipped a row past the namespace check above cannot subsequently
      // hijack the update path either.
      const existing = await db
        .select({
          id: ocpiExternalTokens.id,
          tokenType: ocpiExternalTokens.tokenType,
          isValid: ocpiExternalTokens.isValid,
          whitelist: ocpiExternalTokens.whitelist,
        })
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.partnerId, partner.partnerId),
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

      const previous = existing[0];
      await auditTokenReceived(
        partner.partnerId,
        request.log,
        { uid: token_uid, method: 'PUT', created: previous == null },
        previous != null
          ? { type: previous.tokenType, valid: previous.isValid, whitelist: previous.whitelist }
          : null,
        { type: body.type, valid: body.valid, whitelist: body.whitelist },
      );

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

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      // Same per-partner namespace guard as PUT above: an authenticated
      // partner may only patch tokens it owns.
      if (partner.countryCode !== country_code || partner.partyId !== party_id) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Cannot PATCH tokens for another partner'));
        return;
      }

      const [existing] = await db
        .select()
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.partnerId, partner.partnerId),
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

      const rawBody = request.body;
      if (rawBody == null || typeof rawBody !== 'object') {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'PATCH body must be a JSON object'),
          );
        return;
      }
      const patch = rawBody as Record<string, unknown>;
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

      await auditTokenReceived(
        partner.partnerId,
        request.log,
        { uid: token_uid, method: 'PATCH', created: false },
        { type: existing.tokenType, valid: existing.isValid, whitelist: existing.whitelist },
        {
          type: updateFields['tokenType'] ?? existing.tokenType,
          valid: updateFields['isValid'] ?? existing.isValid,
          whitelist: updateFields['whitelist'] ?? existing.whitelist,
        },
      );

      return ocpiSuccess(null);
    },
  );

  // POST /ocpi/{version}/cpo/tokens/:token_uid/authorize - real-time authorization
  app.post(
    `${prefix}/:token_uid/authorize`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { token_uid } = request.params as { token_uid: string };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return undefined;
      }

      // Per-partner namespace scoping. The eMSP partner asking us to
      // authorize is asking about a token IT previously uploaded. Looking
      // up by uid alone would let partner A enumerate partner B's tokens
      // (existence, validity, full token payload) by guessing token UIDs.
      const [token] = await db
        .select()
        .from(ocpiExternalTokens)
        .where(
          and(
            eq(ocpiExternalTokens.partnerId, partner.partnerId),
            eq(ocpiExternalTokens.uid, token_uid),
          ),
        )
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
    },
  );
}

export function cpoTokenRoutes(app: FastifyInstance): void {
  registerCpoTokenRoutes(app, '2.2.1');
  registerCpoTokenRoutes(app, '2.3.0');
}
