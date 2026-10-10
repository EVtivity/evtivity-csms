// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import {
  successResponse,
  arrayResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-key.service.js';
import { permissionCatalog } from '@evtivity/lib';
import { canGrantPermissions } from '../lib/user-management-scope.js';
import {
  db,
  refreshTokens,
  userPermissions,
  writeAudit,
  apiKeyAuditLog,
  OCTT_API_KEY_NAME,
} from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';
import { getAuditActor } from '../lib/audit-actor.js';

const createApiKeyBody = z.object({
  name: z.string().min(1).max(255).describe('Display name for the API key'),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .nullable()
    .optional()
    .describe('Days until expiry (max 10 years). Null or omitted for non-expiring.'),
  permissions: z
    .array(z.string().max(100))
    .min(1, 'At least one permission is required')
    .max(200)
    .describe('Permission scope. Must be a subset of your permissions.'),
});

const updateApiKeyBody = z.object({
  permissions: z
    .array(z.string().max(100))
    .min(1, 'At least one permission is required')
    .max(200)
    .describe('Permission scope. Must be a subset of your permissions.'),
});

const apiKeyItem = z
  .object({
    id: z.number().int().min(1).describe('Identifier'),
    name: z.string().max(255).nullable().describe('Display name'),
    createdAt: z.coerce.date().describe('Timestamp when the key was created'),
    expiresAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the key expires (null if non-expiring)'),
    lastUsedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the last successful authentication'),
    permissions: z.unknown().nullable().describe('Permission scope granted to this key'),
  })
  .passthrough();

const apiKeyCreatedItem = z
  .object({
    id: z.number().int().min(1).describe('Identifier'),
    name: z.string().max(255).describe('Display name'),
    rawToken: z
      .string()
      .length(64)
      .describe(
        'WARNING: shown only in this response. The full token cannot be retrieved later (only its SHA-256 hash is stored). Copy and store it securely on the client immediately.',
      ),
    expiresAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the key expires (null if non-expiring)'),
    createdAt: z.coerce.date().describe('Timestamp when the key was created'),
    permissions: z.unknown().nullable().describe('Permission scope granted to this key'),
  })
  .passthrough();

const idParams = z.object({ id: z.coerce.number().int().min(1) });

/**
 * Whether a request may change or revoke a key with this scope. A request
 * through an API key acts only on keys whose scope is within its own
 * effective permissions (a narrow key never revokes or rewrites a wider
 * one); a key without an explicit scope carries all of the user's
 * permissions. A session (JWT) request manages every key of its user.
 */
async function keyScopeWithinRequest(
  request: FastifyRequest,
  keyPermissions: unknown,
  userId: string,
): Promise<boolean> {
  if ((request.user as JwtPayload).isApiKey !== true) return true;
  const scope = Array.isArray(keyPermissions)
    ? (keyPermissions as string[])
    : (
        await db
          .select({ permission: userPermissions.permission })
          .from(userPermissions)
          .where(eq(userPermissions.userId, userId))
      ).map((r) => r.permission);
  return canGrantPermissions(request, scope);
}

/** `keyScopeWithinRequest` for a key of the user loaded by id; false when missing. */
async function apiKeyWithinRequestScope(
  request: FastifyRequest,
  id: number,
  userId: string,
): Promise<boolean> {
  if ((request.user as JwtPayload).isApiKey !== true) return true;
  const [key] = await db
    .select({ permissions: refreshTokens.permissions })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.id, id),
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.type, 'api_key'),
        isNull(refreshTokens.revokedAt),
      ),
    );
  return key != null && (await keyScopeWithinRequest(request, key.permissions, userId));
}

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
        description:
          'Generates a 64-character hex API token. The raw token is shown ONLY in this response and cannot be retrieved later (only its SHA-256 hash is stored). Copy it immediately on the client. Optional `permissions` scopes the key to a subset of the creator current permissions; `expiresInDays` sets a hard expiry. Returns 403 if requested permissions exceed the creator permissions. Through an API key with an expiry, the new key expires no later than the calling key, and a request without `expiresInDays` answers 400 VALIDATION_ERROR.',
        operationId: 'createApiKey',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createApiKeyBody),
        response: {
          201: itemResponse(apiKeyCreatedItem),
          400: errorWith('Invalid request', [
            ERROR_CODES.INVALID_PERMISSIONS,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Permissions exceed own', [ERROR_CODES.PERMISSIONS_EXCEED_OWN]),
          409: errorWith('Duplicate api key name', [ERROR_CODES.DUPLICATE_API_KEY_NAME]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof createApiKeyBody>;

      // Reserve the OCTT runner's key name. The auth layer exempts that name
      // from the per-key rate limit, so it must not be operator-creatable.
      if (body.name.trim().toLowerCase() === OCTT_API_KEY_NAME.toLowerCase()) {
        await reply
          .status(400)
          .send({ error: 'This API key name is reserved', code: 'VALIDATION_ERROR' });
        return;
      }

      const requested =
        body.expiresInDays != null
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null;
      // A key created through an expiring API key never outlives it: the
      // expiry is capped at the calling key's, and no expiry is refused.
      const callerExpiresAt = (request.user as JwtPayload).apiKeyExpiresAt;
      if (callerExpiresAt != null && requested == null) {
        await reply.status(400).send({
          error: 'A key created with an expiring API key must expire',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const expiresAt =
        callerExpiresAt != null && requested != null && requested > new Date(callerExpiresAt)
          ? new Date(callerExpiresAt)
          : requested;

      const existingRows = await db
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

      if (existingRows[0] != null) {
        await reply.status(409).send({
          error: 'An API key with this name already exists',
          code: 'DUPLICATE_API_KEY_NAME',
        });
        return;
      }

      // Validate all permissions are in the catalog
      const invalid = body.permissions.filter((p) => !permissionCatalog.isKnown(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      // The request's effective permissions, API key scope included: a key
      // never mints a key beyond its own scope.
      if (!(await canGrantPermissions(request, body.permissions))) {
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: apiKeyAuditLog, idColumn: 'api_key_id' },
        {
          entityId: String(result.id),
          entityIdSnapshot: String(result.id),
          action: 'created',
          ...actor,
          after: {
            id: result.id,
            name: result.name,
            expiresAt: result.expiresAt,
            createdAt: result.createdAt,
            permissions: body.permissions,
          },
        },
        db,
        request.log,
      );

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
        response: {
          200: successResponse,
          404: errorWith('Api key not found', [ERROR_CODES.API_KEY_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;

      // Through an API key, only a key within the request's scope.
      if (!(await apiKeyWithinRequestScope(request, id, userId))) {
        await reply.status(404).send({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
        return;
      }
      const revoked = await revokeApiKey(id, userId);
      if (!revoked) {
        await reply.status(404).send({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: apiKeyAuditLog, idColumn: 'api_key_id' },
        {
          entityId: String(id),
          entityIdSnapshot: String(id),
          action: 'revoked',
          ...actor,
        },
        db,
        request.log,
      );
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
          400: errorWith('Invalid permissions', [ERROR_CODES.INVALID_PERMISSIONS]),
          403: errorWith('Permissions exceed own', [ERROR_CODES.PERMISSIONS_EXCEED_OWN]),
          404: errorWith('Api key not found', [ERROR_CODES.API_KEY_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;
      const body = request.body as z.infer<typeof updateApiKeyBody>;

      // Verify ownership and capture the prior permission set so the audit
      // entry can record before/after on the permission change.
      const [key] = await db
        .select({ id: refreshTokens.id, permissions: refreshTokens.permissions })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.id, id),
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.type, 'api_key'),
            isNull(refreshTokens.revokedAt),
          ),
        );
      // Through an API key, only a key within the request's scope, with the
      // same answer as a missing key.
      if (key == null || !(await keyScopeWithinRequest(request, key.permissions, userId))) {
        await reply.status(404).send({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
        return;
      }

      // Validate permissions
      const invalid = body.permissions.filter((p) => !permissionCatalog.isKnown(p));
      if (invalid.length > 0) {
        await reply.status(400).send({
          error: `Invalid permissions: ${invalid.join(', ')}`,
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      // The request's effective permissions, API key scope included: a key
      // never widens a key beyond its own scope.
      if (!(await canGrantPermissions(request, body.permissions))) {
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: apiKeyAuditLog, idColumn: 'api_key_id' },
        {
          entityId: String(id),
          entityIdSnapshot: String(id),
          action: 'updated',
          ...actor,
          before: { id, permissions: key.permissions },
          after: { id, permissions: body.permissions },
        },
        db,
        request.log,
      );

      return { success: true as const };
    },
  );
}
