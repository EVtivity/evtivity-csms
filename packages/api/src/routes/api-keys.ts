// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  arrayResponse,
  itemResponse,
} from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-key.service.js';
import { PERMISSIONS, isSubsetOf } from '@evtivity/lib';
import { db, userPermissions, refreshTokens } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';

const createApiKeyBody = z.object({
  name: z.string().min(1).max(255).describe('Display name for the API key'),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe('Days until expiry. Null or omitted for non-expiring.'),
  permissions: z
    .array(z.string())
    .min(1, 'At least one permission is required')
    .describe('Permission scope. Must be a subset of your permissions.'),
});

const updateApiKeyBody = z.object({
  permissions: z
    .array(z.string())
    .min(1, 'At least one permission is required')
    .describe('Permission scope. Must be a subset of your permissions.'),
});

const apiKeyItem = z
  .object({
    id: z.number(),
    name: z.string().nullable(),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullable(),
    lastUsedAt: z.coerce.date().nullable(),
    permissions: z.unknown().nullable(),
  })
  .passthrough();

const apiKeyCreatedItem = z
  .object({
    id: z.number(),
    name: z.string(),
    rawToken: z.string(),
    expiresAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    permissions: z.unknown().nullable(),
  })
  .passthrough();

const idParams = z.object({ id: z.coerce.number().int().min(1) });

export function apiKeyRoutes(app: FastifyInstance): void {
  app.get(
    '/api-keys',
    {
      onRequest: [authorize('settings.apiKeys:read')],
      schema: {
        tags: ['API Keys'],
        summary: 'List active API keys for the current user',
        operationId: 'listApiKeys',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(apiKeyItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      return listApiKeys(userId);
    },
  );

  app.post(
    '/api-keys',
    {
      onRequest: [authorize('settings.apiKeys:write')],
      schema: {
        tags: ['API Keys'],
        summary: 'Create a new API key',
        operationId: 'createApiKey',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createApiKeyBody),
        response: {
          201: itemResponse(apiKeyCreatedItem),
          400: errorResponse,
          403: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof createApiKeyBody>;

      const expiresAt =
        body.expiresInDays != null
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null;

      // Check for duplicate name
      const [existing] = await db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.type, 'api_key'),
            eq(refreshTokens.name, body.name.trim()),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .limit(1);
      if (existing != null) {
        await reply.status(409).send({
          error: 'An API key with this name already exists',
          code: 'DUPLICATE_API_KEY_NAME',
        });
        return;
      }

      // Validate all permissions are in the catalog
      const catalogSet = new Set<string>(PERMISSIONS);
      const invalid = body.permissions.filter((p) => !catalogSet.has(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      // Validate permissions are a subset of the creator's permissions
      const creatorPermRows = await db
        .select({ permission: userPermissions.permission })
        .from(userPermissions)
        .where(eq(userPermissions.userId, userId));
      const creatorPerms = creatorPermRows.map((r) => r.permission);

      if (!isSubsetOf(body.permissions, creatorPerms)) {
        await reply.status(403).send({
          error: 'API key permissions must be a subset of your own permissions',
          code: 'PERMISSIONS_EXCEED_OWN',
        });
        return;
      }

      const result = await createApiKey({
        userId,
        name: body.name.trim(),
        expiresAt,
        permissions: body.permissions,
      });

      await reply.status(201).send({
        id: result.id,
        name: result.name,
        rawToken: result.rawToken,
        expiresAt: result.expiresAt,
        createdAt: result.createdAt,
        permissions: body.permissions,
      });
    },
  );

  app.delete(
    '/api-keys/:id',
    {
      onRequest: [authorize('settings.apiKeys:write')],
      schema: {
        tags: ['API Keys'],
        summary: 'Revoke an API key',
        operationId: 'revokeApiKey',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;

      const revoked = await revokeApiKey(id, userId);
      if (!revoked) {
        await reply.status(404).send({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
        return;
      }
      return { success: true as const };
    },
  );

  app.patch(
    '/api-keys/:id',
    {
      onRequest: [authorize('settings.apiKeys:write')],
      schema: {
        tags: ['API Keys'],
        summary: 'Update API key permissions',
        operationId: 'updateApiKey',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(updateApiKeyBody),
        response: {
          200: successResponse,
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;
      const body = request.body as z.infer<typeof updateApiKeyBody>;

      // Verify ownership
      const [key] = await db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.id, id),
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.type, 'api_key'),
            isNull(refreshTokens.revokedAt),
          ),
        );
      if (key == null) {
        await reply.status(404).send({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
        return;
      }

      // Validate permissions
      const catalogSet = new Set<string>(PERMISSIONS);
      const invalid = body.permissions.filter((p) => !catalogSet.has(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      const creatorPermRows = await db
        .select({ permission: userPermissions.permission })
        .from(userPermissions)
        .where(eq(userPermissions.userId, userId));
      const creatorPerms = creatorPermRows.map((r) => r.permission);

      if (!isSubsetOf(body.permissions, creatorPerms)) {
        await reply.status(403).send({
          error: 'API key permissions must be a subset of your own permissions',
          code: 'PERMISSIONS_EXCEED_OWN',
        });
        return;
      }

      await db
        .update(refreshTokens)
        .set({ permissions: body.permissions })
        .where(eq(refreshTokens.id, id));

      return { success: true as const };
    },
  );
}
