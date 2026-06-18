// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRefreshToken } from '../services/refresh-token.service.js';
import { setAuthCookies, isSecureRequest } from './auth-cookies.js';
import type { DriverJwtPayload } from '../plugins/auth.js';

const ACCESS_TOKEN_TTL_SECONDS = 3600;

// Native clients send this header so the server returns tokens in the body and
// sets no cookies. A browser never sends it, so the web path is unchanged.
export function isMobileClient(request: FastifyRequest): boolean {
  return request.headers['x-client'] === 'mobile';
}

// Stable per-install id the app generates and keeps in secure storage. Used to
// device-bind the refresh token. Capped at the column width.
export function deviceIdFromRequest(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-device-id'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 64);
}

/**
 * Issue a driver session. Web clients (no `X-Client: mobile`) get httpOnly auth
 * cookies and a `{ driver }` body, exactly as before. Mobile clients get the
 * access and refresh tokens in the body and no cookies, because native clients
 * cannot read httpOnly cookies. The mobile refresh token is device-bound.
 *
 * The caller passes the driver object already shaped for the response. This
 * helper only handles the token/cookie branching and sends the response.
 */
export async function issueDriverSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  driver: { id: string } & Record<string, unknown>,
  opts?: { status?: number },
): Promise<void> {
  const status = opts?.status ?? 200;
  const accessToken = app.jwt.sign(
    { driverId: driver.id, type: 'driver' } satisfies DriverJwtPayload,
    { expiresIn: '1h' },
  );

  if (isMobileClient(request)) {
    const refreshResult = await createRefreshToken({
      driverId: driver.id,
      deviceId: deviceIdFromRequest(request),
    });
    await reply.status(status).send({
      driver,
      token: accessToken,
      refreshToken: refreshResult.rawToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
    return;
  }

  const refreshResult = await createRefreshToken({ driverId: driver.id });
  setAuthCookies('portal', reply, accessToken, refreshResult.rawToken, isSecureRequest(request));
  await reply.status(status).send({ driver });
}
