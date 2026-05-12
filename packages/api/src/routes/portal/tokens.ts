// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { driverTokens } from '@evtivity/database';
import * as tokenService from '../../services/token.service.js';
import { OCPP_TOKEN_TYPES } from '../tokens.js';
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

// Driver-facing subset of OCPP IdToken types. Excludes Central (CSMS-issued
// internal tokens) and NoAuthorization (system marker), which a real driver
// would never register from the portal.
const PORTAL_TOKEN_TYPES = OCPP_TOKEN_TYPES.filter(
  (t) => t !== 'Central' && t !== 'NoAuthorization',
) as readonly Exclude<(typeof OCPP_TOKEN_TYPES)[number], 'Central' | 'NoAuthorization'>[];
const portalTokenTypeSchema = z.enum(PORTAL_TOKEN_TYPES as unknown as [string, ...string[]]);

const tokenItem = z
  .object({
    id: z.string().describe('Driver token ID (nanoid prefixed with dtk_)'),
    driverId: z.string().nullable().describe('Owning driver ID'),
    idToken: z.string().max(255).describe('RFID card UID or token identifier'),
    tokenType: z.string().max(20).describe('OCPP IdToken type'),
    isActive: z.boolean().describe('Whether the token is currently active'),
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
      return db
        .select({
          id: driverTokens.id,
          driverId: driverTokens.driverId,
          idToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          isActive: driverTokens.isActive,
          createdAt: driverTokens.createdAt,
        })
        .from(driverTokens)
        .where(eq(driverTokens.driverId, driverId));
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
        operationId: 'portalCreateToken',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTokenBody),
        response: {
          201: itemResponse(tokenItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
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
        await reply.status(201).send(token);
      } catch (err) {
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
        operationId: 'portalUpdateToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        body: zodSchema(updateTokenBody),
        response: {
          200: itemResponse(tokenItem),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof tokenParams>;
      const body = request.body as z.infer<typeof updateTokenBody>;

      const [existing] = await db
        .select({ id: driverTokens.id, driverId: driverTokens.driverId })
        .from(driverTokens)
        .where(eq(driverTokens.id, id));

      if (existing == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      if (existing.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const updated = await tokenService.updateToken(
        id,
        { isActive: body.isActive },
        { type: 'driver', driverId },
      );
      return updated;
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
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Token not found', [ERROR_CODES.TOKEN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof tokenParams>;

      const [existing] = await db
        .select({ id: driverTokens.id, driverId: driverTokens.driverId })
        .from(driverTokens)
        .where(eq(driverTokens.id, id));

      if (existing == null) {
        await reply.status(404).send({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      if (existing.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      await tokenService.updateToken(
        id,
        { isActive: false, revokedReason: 'Removed by driver' },
        { type: 'driver', driverId },
      );

      return { success: true };
    },
  );
}
