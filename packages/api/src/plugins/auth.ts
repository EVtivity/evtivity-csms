// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from '@fastify/jwt';
import { db } from '@evtivity/database';
import { refreshTokens, users, drivers, userPermissions } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { isApiKeyRateLimited } from '../lib/rate-limiters.js';
import { getPubSub } from '../lib/pubsub.js';
import { hashToken } from '../lib/token-hash.js';

export interface JwtPayload {
  userId: string;
  roleId: string;
  isApiKey?: boolean;
  apiKeyName?: string;
  apiKeyPermissions?: string[];
  /**
   * Set on the short-lived JWT issued during the MFA challenge step. Tokens
   * carrying this flag are only valid for /auth/mfa/verify and
   * /auth/mfa/resend; `app.authenticate` rejects them on every other route.
   */
  mfaPending?: boolean;
}

export interface DriverJwtPayload {
  driverId: string;
  type: 'driver';
  /** Same as JwtPayload.mfaPending but for the driver portal flow. */
  mfaPending?: boolean;
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

/** Clear the in-process cache only. Used by the cache-invalidate pub/sub
 *  listener so a broadcast invalidation does not re-publish. */
export function clearUserActiveCacheLocal(userId: string): void {
  userActiveCache.delete(userId);
}

/** Clear cached isActive status for a user. Call after deactivation.
 *  Also broadcasts to other API pods so they drop their local entry too. */
export function invalidateUserActiveCache(userId: string): void {
  clearUserActiveCacheLocal(userId);
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'active', userId }))
    .catch(() => {
      // Best-effort; falls back to TTL on other pods.
    });
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
      // Reject driver JWTs presented to operator routes. The two realms share
      // a signing key, so jwtVerify() validates a driver token here. Cookie
      // path scoping (portal_token is /v1/portal) prevents the normal browser
      // from sending it cross-realm, but an attacker with the raw JWT can
      // submit it as Authorization: Bearer to any operator route. Without
      // this guard such a request would reach a handler that calls
      // request.user.userId (undefined) and fail in surprising ways.
      if (jwtUser['type'] === 'driver' || typeof jwtUser['userId'] !== 'string') {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      // Reject MFA-pending tokens on regular routes. The mfaPending JWT issued
      // during the login flow is only valid for /auth/mfa/verify and /auth/mfa/resend.
      if (jwtUser['mfaPending'] === true) {
        await reply.status(401).send({ error: 'MFA verification required', code: 'MFA_REQUIRED' });
        return;
      }
      if (!(await isUserActive(jwtUser['userId']))) {
        await reply.status(401).send({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
        return;
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
          const payloadRecord = payload as unknown as Record<string, unknown>;
          // Reject driver JWTs in the csms_token cookie slot too. The cookie
          // is normally only set by operator login, but rejecting on payload
          // shape rather than cookie name keeps the defense at the JWT layer.
          if (payloadRecord['type'] === 'driver' || typeof payloadRecord['userId'] !== 'string') {
            await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
            return;
          }
          // Reject MFA-pending tokens on regular routes.
          if (payloadRecord['mfaPending'] === true) {
            await reply
              .status(401)
              .send({ error: 'MFA verification required', code: 'MFA_REQUIRED' });
            return;
          }
          // Check if user is still active (catches deactivated users with valid JWTs)
          if (!(await isUserActive(payload.userId))) {
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
          const tokenHash = hashToken(token);
          const [row] = await db
            .select({
              id: refreshTokens.id,
              userId: refreshTokens.userId,
              name: refreshTokens.name,
              expiresAt: refreshTokens.expiresAt,
              permissions: refreshTokens.permissions,
              lastUsedAt: refreshTokens.lastUsedAt,
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

              // Throttled fire-and-forget lastUsedAt update. A heavily used
              // API key (e.g. a poller hitting once per second) would otherwise
              // generate a row update on every single request, hammering WAL
              // and replication. One-per-hour granularity is plenty for the
              // "last used" badge in the UI and audit queries.
              const LAST_USED_THROTTLE_MS = 3600_000;
              const lastUsedStale =
                row.lastUsedAt == null ||
                Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS;
              if (lastUsedStale) {
                db.update(refreshTokens)
                  .set({ lastUsedAt: new Date() })
                  .where(eq(refreshTokens.id, row.id))
                  .then(() => {})
                  .catch((err: unknown) => {
                    app.log.warn({ err }, 'Failed to update API key lastUsedAt');
                  });
              }

              return;
            }
          }
        }
      }

      await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
  });

  app.decorate('authenticateDriver', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const payload = request.user as unknown as Record<string, unknown>;
      if (payload['type'] !== 'driver') {
        await reply
          .status(403)
          .send({ error: 'Forbidden: driver token required', code: 'FORBIDDEN_DRIVER_TOKEN' });
        return;
      }
      // Reject MFA-pending tokens on regular routes. The mfaPending JWT issued
      // during the driver login flow is only valid for portal MFA verify/resend.
      if (payload['mfaPending'] === true) {
        await reply.status(401).send({ error: 'MFA verification required', code: 'MFA_REQUIRED' });
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
      await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
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
