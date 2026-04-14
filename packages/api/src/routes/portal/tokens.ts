// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { driverTokens } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import {
  errorResponse,
  arrayResponse,
  itemResponse,
  successResponse,
} from '../../lib/response-schemas.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const tokenItem = z
  .object({
    id: z.string(),
    driverId: z.string().nullable(),
    idToken: z.string(),
    tokenType: z.string(),
    isActive: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const createTokenBody = z.object({
  idToken: z
    .string()
    .min(4)
    .max(20)
    .regex(/^[a-zA-Z0-9]+$/, 'Must be alphanumeric')
    .describe('RFID card identifier'),
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
      schema: {
        tags: ['Portal Tokens'],
        summary: 'Add RFID card',
        operationId: 'portalCreateToken',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTokenBody),
        response: { 201: itemResponse(tokenItem), 400: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createTokenBody>;

      const [existing] = await db
        .select({ id: driverTokens.id })
        .from(driverTokens)
        .where(eq(driverTokens.idToken, body.idToken));

      if (existing != null) {
        await reply
          .status(409)
          .send({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
        return;
      }

      const [token] = await db
        .insert(driverTokens)
        .values({
          driverId,
          idToken: body.idToken,
          tokenType: 'ISO14443',
          isActive: true,
        })
        .returning();

      return reply.status(201).send(token);
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
        response: { 200: itemResponse(tokenItem), 403: errorResponse, 404: errorResponse },
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

      const [updated] = await db
        .update(driverTokens)
        .set({ isActive: body.isActive, updatedAt: new Date() })
        .where(eq(driverTokens.id, id))
        .returning();

      return updated;
    },
  );

  app.delete(
    '/portal/tokens/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Tokens'],
        summary: 'Delete RFID card',
        operationId: 'portalDeleteToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tokenParams),
        response: { 200: successResponse, 403: errorResponse, 404: errorResponse },
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

      await db.delete(driverTokens).where(eq(driverTokens.id, id));

      return { success: true };
    },
  );
}
