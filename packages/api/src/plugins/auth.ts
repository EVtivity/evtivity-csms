// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from '@fastify/jwt';
import { db } from '@evtivity/database';
import { refreshTokens, users, userPermissions, OCTT_API_KEY_NAME } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { isApiKeyRateLimited } from '../lib/rate-limiters.js';
import { hashToken } from '../lib/token-hash.js';
import { isDriverActive } from '../lib/driver-active.js';
import { isUserActive } from '../lib/user-active.js';

// A missing, expired or forged token is routine: log it at debug. Anything
// else (a database error while checking the account) is logged at warn.
function logAuthFailure(request: FastifyRequest, err: unknown, msg: string): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^(FST_JWT|FAST_JWT)_/.test(code)) {
    request.log.debug({ err }, msg);
  } else {
    request.log.warn({ err }, msg);
  }
}

export interface JwtPayload {
  userId: string;
  roleId: string;
  isApiKey?: boolean;
  apiKeyName?: string;
  apiKeyPermissions?: string[];
  /**
   * The calling API key's expiry (ISO 8601), when it has one. A key it
   * creates never outlives it (`POST /v1/api-keys`).
   */
  apiKeyExpiresAt?: string;
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

/** Why a verified operator JWT may not be used, or null when it may. */
export interface OperatorTokenRejection {
  error: string;
  code: 'UNAUTHORIZED' | 'MFA_REQUIRED' | 'ACCOUNT_DEACTIVATED';
}

/**
 * The checks every operator route applies to a JWT after its signature and
 * expiry verified: a driver token (the two realms share a signing key) or a
 * token without a userId is refused, an MFA-pending token is refused, and a
 * deactivated user is refused. Used by `app.authenticate` and by the SSE
 * stream, which verifies its token itself.
 */
export async function operatorTokenRejection(
  payload: unknown,
): Promise<OperatorTokenRejection | null> {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (record['type'] === 'driver' || typeof record['userId'] !== 'string') {
    return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
  }
  if (record['mfaPending'] === true) {
    return { error: 'MFA verification required', code: 'MFA_REQUIRED' };
  }
  if (!(await isUserActive(record['userId']))) {
    return { error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' };
  }
  return null;
}

/** Why a verified driver JWT may not be used, or null when it may. */
export interface DriverTokenRejection {
  status: 401 | 403;
  error: string;
  code: 'FORBIDDEN_DRIVER_TOKEN' | 'MFA_REQUIRED' | 'ACCOUNT_DEACTIVATED';
}

/**
 * The checks every driver route applies to a JWT after its signature and
 * expiry verified: an operator token is refused (the two realms share a
 * signing key), an MFA-pending token is refused (it is valid only for the
 * portal MFA verify and resend routes), and a deactivated driver is refused.
 * Used by `app.authenticateDriver` and by the portal SSE stream, which
 * verifies its token itself.
 */
export async function driverTokenRejection(payload: unknown): Promise<DriverTokenRejection | null> {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (record['type'] !== 'driver') {
    return {
      status: 403,
      error: 'Forbidden: driver token required',
      code: 'FORBIDDEN_DRIVER_TOKEN',
    };
  }
  if (record['mfaPending'] === true) {
    return { status: 401, error: 'MFA verification required', code: 'MFA_REQUIRED' };
  }
  const driverId = record['driverId'];
  if (typeof driverId !== 'string' || !(await isDriverActive(driverId))) {
    return { status: 401, error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' };
  }
  return null;
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
      // Reject driver JWTs presented to operator routes. The two realms share
      // a signing key, so jwtVerify() validates a driver token here. Cookie
      // path scoping (portal_token is /v1/portal) prevents the normal browser
      // from sending it cross-realm, but an attacker with the raw JWT can
      // submit it as Authorization: Bearer to any operator route. Also reject
      // MFA-pending tokens (only valid for /auth/mfa/verify and
      // /auth/mfa/resend) and deactivated users with valid JWTs.
      const rejection = await operatorTokenRejection(request.user);
      if (rejection != null) {
        await reply.status(401).send(rejection);
        return;
      }
      return;
    } catch (err) {
      logAuthFailure(request, err, 'Bearer token check failed, trying the csms_token cookie');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const rawCsmsToken = request.cookies?.['csms_token'];
      if (rawCsmsToken != null && rawCsmsToken !== '') {
        try {
          // Unsign the cookie; fall back to raw value for backward compatibility
          const unsigned = request.unsignCookie(rawCsmsToken);
          const csmsToken = unsigned.valid ? unsigned.value : rawCsmsToken;
          const payload = app.jwt.verify<JwtPayload>(csmsToken);
          (request as unknown as Record<string, unknown>)['user'] = payload;
          // Same checks as the Bearer path. Rejecting on payload shape rather
          // than cookie name keeps the defense at the JWT layer.
          const rejection = await operatorTokenRejection(payload);
          if (rejection != null) {
            await reply.status(401).send(rejection);
            return;
          }
          return;
        } catch (err) {
          logAuthFailure(request, err, 'csms_token cookie check failed, trying an API key');
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
            // Per-API-key rate limiting. The OCTT conformance runner is exempt
            // because it dispatches CSMS-initiated OCPP commands in bursts that
            // legitimately exceed the per-key limit.
            if (row.name !== OCTT_API_KEY_NAME && isApiKeyRateLimited(tokenHash)) {
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
                ...(row.expiresAt != null ? { apiKeyExpiresAt: row.expiresAt.toISOString() } : {}),
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
    } catch (err) {
      logAuthFailure(request, err, 'Driver token check failed, refusing the request');
      await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    const rejection = await driverTokenRejection(request.user);
    if (rejection != null) {
      const { status, ...body } = rejection;
      await reply.status(status).send(body);
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
