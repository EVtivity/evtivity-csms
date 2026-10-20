// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionLifetimes } from '@evtivity/database';
import { createRefreshToken } from '../services/refresh-token.service.js';
import { setAuthCookies, isSecureRequest } from './auth-cookies.js';
import { getDriverSessionState } from './driver-active.js';
import type { DriverJwtPayload } from '../plugins/auth.js';

const DAY_SECONDS = 24 * 60 * 60;

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

/** Tokens a mobile client gets in the response body instead of cookies. */
export interface DriverMobileTokens {
  token: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

/** The driver fields a driver access token is signed from. */
export interface DriverTokenDriver {
  id: string;
  sessionVersion: number;
}

/**
 * Signs a driver access token valid for `expiresInSeconds`. It carries the driver's session
 * version (`sv`): `driverTokenRejection` refuses it once the version moves on (sign-out,
 * password reset or change, deactivation). A token without `sv` counts as 0.
 */
export function signDriverAccessToken(
  app: FastifyInstance,
  driver: DriverTokenDriver,
  expiresInSeconds: number,
): string {
  return app.jwt.sign(
    { driverId: driver.id, type: 'driver', sv: driver.sessionVersion } satisfies DriverJwtPayload,
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Issues a driver access token and refresh token with the driver lifetimes of the session
 * settings. The access token carries the driver's current session version, read here so a
 * caller cannot sign one under a version an earlier read saw. A mobile client (`X-Client: mobile`) gets them back for the response body, with
 * the refresh token bound to its device. A web client gets the auth cookies and `null`.
 */
export async function issueDriverTokens(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  driverId: string,
): Promise<DriverMobileTokens | null> {
  const lifetimes = await getSessionLifetimes();
  const accessSeconds = lifetimes.driverAccessMinutes * 60;
  const lifetimeDays = lifetimes.driverRefreshDays;
  const { sessionVersion } = await getDriverSessionState(driverId);
  const token = signDriverAccessToken(app, { id: driverId, sessionVersion }, accessSeconds);

  if (isMobileClient(request)) {
    const refresh = await createRefreshToken({
      driverId,
      deviceId: deviceIdFromRequest(request),
      lifetimeDays,
    });
    return { token, refreshToken: refresh.rawToken, expiresIn: accessSeconds };
  }

  const refresh = await createRefreshToken({ driverId, lifetimeDays });
  setAuthCookies('portal', reply, token, refresh.rawToken, isSecureRequest(request), {
    accessSeconds,
    refreshSeconds: lifetimeDays * DAY_SECONDS,
  });
  return null;
}

/**
 * Issue a driver session and send the response. Web clients (no `X-Client: mobile`) get
 * httpOnly auth cookies and a `{ driver }` body. Mobile clients get the access and refresh
 * tokens in the body and no cookies, because native clients cannot read httpOnly cookies.
 *
 * The caller passes the driver object already shaped for the response.
 */
export async function issueDriverSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  driver: { id: string } & Record<string, unknown>,
  opts?: { status?: number },
): Promise<void> {
  const status = opts?.status ?? 200;
  const tokens = await issueDriverTokens(app, request, reply, driver.id);
  await reply.status(status).send(tokens == null ? { driver } : { driver, ...tokens });
}
