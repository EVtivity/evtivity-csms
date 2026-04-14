// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import jwt from '@fastify/jwt';
import { db } from '@evtivity/database';
import { refreshTokens, users, drivers, userPermissions } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { isApiKeyRateLimited } from '../lib/rate-limiters.js';

export interface JwtPayload {
  userId: string;
  roleId: string;
  isApiKey?: boolean;
  apiKeyName?: string;
  apiKeyPermissions?: string[];
}

export interface DriverJwtPayload {
  driverId: string;
  type: 'driver';
}

// Cache user isActive status to avoid a DB query on every request.
// Short TTL (30s) balances latency vs deactivation propagation speed.
const userActiveCache = new Map<string, { isActive: boolean; expiresAt: number }>();
const USER_ACTIVE_CACHE_TTL_MS = 30_000;

async function isUserActive(userId: string): Promise<boolean> {
  // Skip DB check in test environment (unit tests mock JWT but not the users table)
  if (config.NODE_ENV === 'test') return true;
  const cached = userActiveCache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.isActive;
  }
  const [row] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  const isActive = row?.isActive ?? false;
  userActiveCache.set(userId, { isActive, expiresAt: Date.now() + USER_ACTIVE_CACHE_TTL_MS });
  return isActive;
}

/** Clear cached isActive status for a user. Call after deactivation. */
export function invalidateUserActiveCache(userId: string): void {
  userActiveCache.delete(userId);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  if (config.JWT_SECRET.length < 32 && config.NODE_ENV !== 'test') {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  await app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: {
      cookieName: 'portal_token',
      signed: true,
    },
  });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Try standard jwtVerify first (checks Authorization header + portal_token cookie)
      await request.jwtVerify();
      // Check if operator user is still active (catches deactivated users with valid JWTs)
      const jwtUser = request.user as unknown as Record<string, unknown>;
      if ('userId' in jwtUser && typeof jwtUser['userId'] === 'string') {
        if (!(await isUserActive(jwtUser['userId']))) {
          await reply
            .status(401)
            .send({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
          return;
        }
      }
      return;
    } catch {
      // Fall back to csms_token cookie (signed cookie)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const rawCsmsToken = request.cookies?.['csms_token'];
      if (rawCsmsToken != null && rawCsmsToken !== '') {
        try {
          // Unsign the cookie; fall back to raw value for backward compatibility
          const unsigned = request.unsignCookie(rawCsmsToken);
          const csmsToken = unsigned.valid ? unsigned.value : rawCsmsToken;
          const payload = app.jwt.verify<JwtPayload>(csmsToken);
          (request as unknown as Record<string, unknown>)['user'] = payload;
          // Check if user is still active (catches deactivated users with valid JWTs)
          if ('userId' in payload && !(await isUserActive(payload.userId))) {
            await reply
              .status(401)
              .send({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
            return;
          }
          return;
        } catch {
          // Invalid cookie token
        }
      }
      // Fallback 2: API key (opaque hex token in Authorization header)
      const authHeader = request.headers['authorization'];
      if (authHeader != null) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (/^[0-9a-f]{64}$/i.test(token)) {
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          const [row] = await db
            .select({
              id: refreshTokens.id,
              userId: refreshTokens.userId,
              name: refreshTokens.name,
              expiresAt: refreshTokens.expiresAt,
              permissions: refreshTokens.permissions,
            })
            .from(refreshTokens)
            .where(
              and(
                eq(refreshTokens.tokenHash, tokenHash),
                eq(refreshTokens.type, 'api_key'),
                isNull(refreshTokens.revokedAt),
              ),
            );

          if (row != null && row.userId != null) {
            // Per-API-key rate limiting
            if (isApiKeyRateLimited(tokenHash)) {
              await reply
                .status(429)
                .send({ error: 'API key rate limit exceeded', code: 'API_KEY_RATE_LIMITED' });
              return;
            }

            // Check expiry
            if (row.expiresAt != null && row.expiresAt < new Date()) {
              await reply.status(401).send({ error: 'API key expired', code: 'API_KEY_EXPIRED' });
              return;
            }

            // Look up user's roleId
            const [user] = await db
              .select({ id: users.id, roleId: users.roleId, isActive: users.isActive })
              .from(users)
              .where(eq(users.id, row.userId));

            if (user != null && user.isActive) {
              const payload: JwtPayload = {
                userId: user.id,
                roleId: user.roleId,
                isApiKey: true,
                ...(row.name != null ? { apiKeyName: row.name } : {}),
              };

              // Attach API key permissions (always set for API keys)
              if (row.permissions != null && Array.isArray(row.permissions)) {
                payload.apiKeyPermissions = row.permissions as string[];
              } else {
                // Legacy keys without explicit permissions: inherit all user permissions
                const permRows = await db
                  .select({ permission: userPermissions.permission })
                  .from(userPermissions)
                  .where(eq(userPermissions.userId, user.id));
                payload.apiKeyPermissions = permRows.map((r) => r.permission);
              }

              (request as unknown as Record<string, unknown>)['user'] = payload;

              // Fire-and-forget lastUsedAt update
              db.update(refreshTokens)
                .set({ lastUsedAt: new Date() })
                .where(eq(refreshTokens.id, row.id))
                .then(() => {})
                .catch((err: unknown) => {
                  app.log.warn({ err }, 'Failed to update API key lastUsedAt');
                });

              return;
            }
          }
        }
      }

      await reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.decorate('authenticateDriver', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const payload = request.user as unknown as Record<string, unknown>;
      if (payload['type'] !== 'driver') {
        await reply.status(403).send({ error: 'Forbidden: driver token required' });
        return;
      }
      // Check if driver account is still active
      const driverId = payload['driverId'];
      if (typeof driverId === 'string' && config.NODE_ENV !== 'test') {
        const [driver] = await db
          .select({ isActive: drivers.isActive })
          .from(drivers)
          .where(eq(drivers.id, driverId));
        if (driver == null || !driver.isActive) {
          await reply
            .status(401)
            .send({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
          return;
        }
      }
    } catch {
      await reply.status(401).send({ error: 'Unauthorized' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateDriver: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload | DriverJwtPayload;
    user: JwtPayload | DriverJwtPayload;
  }
}
