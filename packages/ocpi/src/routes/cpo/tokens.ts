// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db, ocpiExternalTokens, ocpiPartnerAuditLog, writeAudit } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { ocpiParamLimits } from '../../middleware/ocpi-params.js';
import { fitsOcpiString, patchChangesIdentity } from '../../lib/ocpi-fields.js';
import type { OcpiVersion, OcpiToken } from '../../types/ocpi.js';

function isValidToken(body: unknown): body is OcpiToken {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['uid'] === 'string' &&
    fitsOcpiString(obj['type'], 20) &&
    fitsOcpiString(obj['contract_id'], 36) &&
    fitsOcpiString(obj['issuer'], 64) &&
    typeof obj['valid'] === 'boolean' &&
    fitsOcpiString(obj['whitelist'], 20) &&
    typeof obj['country_code'] === 'string' &&
    typeof obj['party_id'] === 'string'
  );
}

/**
 * The token type the URL names: `?type=` on the Tokens receiver URL (OCPI
 * 2.3.0 12.2.2), RFID when absent. Null for a value that is not a TokenType.
 */
function requestedTokenType(query: unknown): string | null {
  const type = (query as Record<string, unknown> | null)?.['type'];
  if (type == null) return 'RFID';
  return fitsOcpiString(type, 20) ? type : null;
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
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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

      const typeParam = (request.query as Record<string, unknown> | null)?.['type'];
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

      if (token == null || (typeof typeParam === 'string' && token.tokenType !== typeParam)) {
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
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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

      // The object in the body is the token the URL names: uid, party and
      // the type from ?type= (RFID when absent).
      const urlType = requestedTokenType(request.query);
      const identityProblem =
        body.uid !== token_uid
          ? 'uid'
          : body.country_code !== country_code
            ? 'country_code'
            : body.party_id !== party_id
              ? 'party_id'
              : body.type !== urlType
                ? 'type'
                : null;
      if (identityProblem != null) {
        await reply
          .status(400)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_INVALID_PARAMS,
              `Token ${identityProblem} does not match the URL`,
            ),
          );
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
        // Two concurrent first PUTs of one token: the later one updates the
        // row instead of failing on ocpi_external_tokens_unique. The partner
        // namespace check above keeps the row in this partner's namespace.
        await db
          .insert(ocpiExternalTokens)
          .values({
            partnerId: partner.partnerId,
            countryCode: country_code,
            partyId: party_id,
            uid: token_uid,
            tokenType: body.type,
            isValid: body.valid,
            whitelist: body.whitelist,
            tokenData: body,
          })
          .onConflictDoUpdate({
            target: [
              ocpiExternalTokens.countryCode,
              ocpiExternalTokens.partyId,
              ocpiExternalTokens.uid,
            ],
            set: {
              tokenType: sql`excluded.token_type`,
              isValid: sql`excluded.is_valid`,
              whitelist: sql`excluded.whitelist`,
              tokenData: sql`excluded.token_data`,
              updatedAt: sql`now()`,
            },
            setWhere: eq(ocpiExternalTokens.partnerId, partner.partnerId),
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
    { onRequest: [ocpiAuthenticate], preHandler: [ocpiParamLimits] },
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

      const patchType = (request.query as Record<string, unknown> | null)?.['type'];
      if (existing == null || (typeof patchType === 'string' && existing.tokenType !== patchType)) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_TOKEN, 'Token not found'));
        return;
      }

      const rawBody = request.body;
      if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'PATCH body must be a JSON object'),
          );
        return;
      }
      const patch = rawBody as Record<string, unknown>;
      // A PATCH updates the token the URL names; it cannot rename it or move
      // it to another party.
      const identity = patchChangesIdentity(patch, { uid: token_uid, country_code, party_id }, [
        'uid',
        'country_code',
        'party_id',
      ]);
      if (identity != null) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, `Cannot change ${identity}`));
        return;
      }
      for (const [field, max] of [
        ['type', 20],
        ['whitelist', 20],
        ['contract_id', 36],
        ['issuer', 64],
      ] as const) {
        if (patch[field] != null && !fitsOcpiString(patch[field], max)) {
          await reply
            .status(400)
            .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, `Invalid ${field}`));
          return;
        }
      }
      if (patch['valid'] != null && typeof patch['valid'] !== 'boolean') {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid valid'));
        return;
      }
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
}

export function cpoTokenRoutes(app: FastifyInstance): void {
  registerCpoTokenRoutes(app, '2.2.1');
  registerCpoTokenRoutes(app, '2.3.0');
}
