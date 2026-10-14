// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { driverTokens } from '@evtivity/database';
import { DRIVER_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import * as tokenService from '../../services/token.service.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import {
  errorResponse,
  arrayResponse,
  itemResponse,
  successResponse,
  errorWith,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

// Driver-facing subset of the OCPP IdToken types (DRIVER_ID_TOKEN_TYPES):
// Central, NoAuthorization and DirectPayment are not something a driver holds.
const portalTokenTypeSchema = z.enum(DRIVER_ID_TOKEN_TYPES as unknown as [string, ...string[]]);

const tokenItem = z
  .object({
    id: z.string().describe('Driver token ID (nanoid prefixed with dtk_)'),
    driverId: z.string().nullable().describe('Owning driver ID'),
    idToken: z.string().max(255).describe('RFID card UID or token identifier'),
    tokenType: z.string().max(20).describe('OCPP IdToken type'),
    isActive: z.boolean().describe('Whether the token is currently active'),
    expiresAt: z.coerce
      .date()
      .nullable()
      .describe('Expiry set by the operator, null when the token does not expire'),
    blockedByOperator: z
      .boolean()
      .describe(
        'True when the operator deactivated the token: only the operator can reactivate it',
      ),
    createdAt: z.coerce.date().describe('Timestamp the token was registered'),
  })
  .passthrough();

const createTokenBody = z.object({
  idToken: z
    .string()
    .min(4)
    .max(64)
    .regex(/^[a-zA-Z0-9-]+$/, 'Must be alphanumeric (dashes allowed)')
    .describe('RFID card identifier'),
  tokenType: portalTokenTypeSchema
    .default('ISO14443')
    .describe('OCPP IdToken type (defaults to ISO14443)'),
});

const updateTokenBody = z.object({
  isActive: z.boolean().describe('Whether the token is active'),
});

const tokenParams = z.object({
  id: ID_PARAMS.driverTokenId.describe('Driver token ID'),
});

const portalTokenColumns = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  isActive: driverTokens.isActive,
  expiresAt: driverTokens.expiresAt,
  deactivatedBy: driverTokens.deactivatedBy,
  createdAt: driverTokens.createdAt,
};

interface PortalTokenRow {
  id: string;
  driverId: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  expiresAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
}

/** The driver-facing shape: who deactivated a card becomes whether the driver can undo it. */
function toPortalToken(row: PortalTokenRow) {
  return {
    id: row.id,
    driverId: row.driverId,
    idToken: row.idToken,
    tokenType: row.tokenType,
    isActive: row.isActive,
    expiresAt: row.expiresAt,
    blockedByOperator: !row.isActive && row.deactivatedBy !== 'driver',
    createdAt: row.createdAt,
  };
}

/** The driver's own token, or null: another driver's token answers like a missing one. */
async function findOwnToken(id: string, driverId: string): Promise<PortalTokenRow | null> {
  const [row] = await db
    .select(portalTokenColumns)
    .from(driverTokens)
    .where(and(eq(driverTokens.id, id), eq(driverTokens.driverId, driverId)));
  return row ?? null;
}

export function portalTokenRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/tokens',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Tokens'],
        summary: 'List driver RFID tokens',
        operationId: 'portalListTokens',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(tokenItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const rows = await db
        .select(portalTokenColumns)
        .from(driverTokens)
        .where(eq(driverTokens.driverId, driverId))
        .orderBy(desc(driverTokens.createdAt), desc(driverTokens.id));
      return rows.map(toPortalToken);
    },
  );

  app.post(
    '/portal/tokens',
    {
      onRequest: [app.authenticateDriver],
      // Rate-limit per-driver to defeat token-enumeration probing via the 409
      // duplicate response. A real driver registers a card or two; an attacker
      // would need to probe many (idToken, tokenType) pairs to enumerate.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Tokens'],
        summary: 'Add RFID card',
        description:
          'Registers a card on the driver account. Adding a card the driver removed earlier reactivates it; a card the operator deactivated answers 403 TOKEN_BLOCKED_BY_OPERATOR.',
        operationId: 'portalCreateToken',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTokenBody),
        response: {
          201: itemResponse(tokenItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          403: errorWith('The operator deactivated this card', [
            ERROR_CODES.TOKEN_BLOCKED_BY_OPERATOR,
          ]),
          409: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createTokenBody>;

      try {
        const token = await tokenService.createToken(
          {
            driverId,
            idToken: body.idToken,
            tokenType: body.tokenType,
          },
          { type: 'driver', driverId },
        );
        if (token == null) throw new Error('Token insert returned no row');
        await reply.status(201).send(toPortalToken(token));
      } catch (err) {
        // Only a card already on this driver's account can be operator
        // blocked here (re-adding it reactivates it), so the answer tells the
        // driver nothing about other drivers' cards.
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(403).send({
            error: 'This card was deactivated by the operator',
            code: 'TOKEN_BLOCKED_BY_OPERATOR',
          });
          return;
        }
        if (err instanceof tokenService.TokenReactivationBlockedError) {
          await reply.status(403).send({
            error: 'This card was deactivated by the operator',
            code: 'TOKEN_BLOCKED_BY_OPERATOR',
          });
          return;
        }
        if (err instanceof tokenService.DuplicateTokenError) {
          // Generic message + code so the response cannot be used to enumerate
          // other drivers' cards. Operator side gets the same code but with
          // surrounding admin context the cardholder doesn't have.
          await reply
            .status(409)
            .send({ error: 'Cannot register this token', code: 'TOKEN_DUPLICATE' });
          return;
        }
        throw err;
      }
    },
  );

  app.patch(
    '/portal/tokens/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Tokens'],
        summary: 'Toggle RFID token active status',
        description:
          'Deactivates or reactivates one of the driver cards. The driver can reactivate only a card the driver deactivated: a card the operator deactivated answers 403 TOKEN_BLOCKED_BY_OPERATOR.',
        operationId: 'portalUpdateToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        body: zodSchema(updateTokenBody),
        response: {
          200: itemResponse(tokenItem),
          403: errorWith('The operator deactivated this card', [
            ERROR_CODES.TOKEN_BLOCKED_BY_OPERATOR,
          ]),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof tokenParams>;
      const body = request.body as z.infer<typeof updateTokenBody>;

      // Another driver's token answers 404 like a missing one, so token ids
      // cannot be probed.
      const own = await findOwnToken(id, driverId);
      if (own == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      // No change: no audit row, no notification.
      if (own.isActive === body.isActive) return toPortalToken(own);

      try {
        await tokenService.updateToken(
          id,
          { isActive: body.isActive },
          { type: 'driver', driverId },
        );
      } catch (err) {
        if (err instanceof tokenService.PncContractTokenError) {
          await reply.status(403).send({
            error: 'This card was deactivated by the operator',
            code: 'TOKEN_BLOCKED_BY_OPERATOR',
          });
          return;
        }
        if (err instanceof tokenService.TokenReactivationBlockedError) {
          await reply.status(403).send({
            error: 'This card was deactivated by the operator',
            code: 'TOKEN_BLOCKED_BY_OPERATOR',
          });
          return;
        }
        throw err;
      }
      const row = await findOwnToken(id, driverId);
      if (row == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      return toPortalToken(row);
    },
  );

  // Drivers cannot hard-delete tokens because the historical session records
  // (via charging_sessions.token_id) and the audit trail need to remain
  // referenceable. The portal "remove" action deactivates instead. Operators
  // hit the operator route for true deletion.
  app.delete(
    '/portal/tokens/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Tokens'],
        summary: 'Deactivate (soft-delete) an RFID card',
        operationId: 'portalDeleteToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        response: {
          200: successResponse,
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof tokenParams>;

      // Another driver's token answers 404 like a missing one.
      const own = await findOwnToken(id, driverId);
      if (own == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      // Already inactive: nothing to remove, and an operator's reason and
      // block stay as they are.
      if (!own.isActive) return { success: true };

      await tokenService.updateToken(
        id,
        { isActive: false, revokedReason: 'Removed by driver' },
        { type: 'driver', driverId },
      );

      return { success: true };
    },
  );
}
