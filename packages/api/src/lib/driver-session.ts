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
  client: DriverClient = null,
): string {
  const payload: DriverJwtPayload = {
    driverId: driver.id,
    type: 'driver',
    sv: driver.sessionVersion,
    ...(client === 'mobile' ? { client } : {}),
  };
  return app.jwt.sign(payload, { expiresIn: expiresInSeconds });
}

/** The client a driver token is issued to: the mobile app, or none (the portal). */
export type DriverClient = 'mobile' | null;

/**
 * The client claim of tokens issued for this request. A request signed in with a driver token
 * keeps that token's claim, so a cookie session never turns into a mobile one; a sign-in step
 * takes it from `X-Client: mobile`.
 */
export function issuedDriverClient(request: FastifyRequest): DriverClient {
  if (request.driverAuthSource != null) {
    return (request.user as DriverJwtPayload).client === 'mobile' ? 'mobile' : null;
  }
  return isMobileClient(request) ? 'mobile' : null;
}

/** Whether the request was signed in with an access token issued to the mobile app. */
export function isMobileSession(request: FastifyRequest): boolean {
  return (
    request.driverAuthSource === 'bearer' && (request.user as DriverJwtPayload).client === 'mobile'
  );
}

/**
 * Issues a driver access token and refresh token with the driver lifetimes of the session
 * settings. The access token carries the driver's current session version, read here so a
 * caller cannot sign one under a version an earlier read saw. A mobile client (`X-Client: mobile`) gets them back for the response body, with
 * the refresh token bound to its device. A web client gets the auth cookies and `null`.
 * The access token carries the client claim of `issuedDriverClient`, or `opts.client` (a
 * renewal passes the client its refresh token was issued to).
 */
export async function issueDriverTokens(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  driverId: string,
  opts?: { client?: DriverClient },
): Promise<DriverMobileTokens | null> {
  const lifetimes = await getSessionLifetimes();
  const accessSeconds = lifetimes.driverAccessMinutes * 60;
  const lifetimeDays = lifetimes.driverRefreshDays;
  const { sessionVersion } = await getDriverSessionState(driverId);
  const client = opts?.client !== undefined ? opts.client : issuedDriverClient(request);
  const token = signDriverAccessToken(app, { id: driverId, sessionVersion }, accessSeconds, client);

  if (isMobileClient(request)) {
    const refresh = await createRefreshToken({
      driverId,
      deviceId: deviceIdFromRequest(request),
      client,
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

/** Fields a sign-in reply may add next to the driver. Never a token field: those come from the issuer. */
export interface DriverSessionExtra {
  mfaEnrollmentRequired?: true;
  recoveryCodesRemaining?: number;
  /** A required MFA enrollment that signs the driver in: MFA is on and the codes show once. */
  success?: true;
  recoveryCodes?: string[];
  /** A passkey registered as the enrolled factor. */
  credential?: Record<string, unknown>;
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
  opts?: { status?: number; extra?: DriverSessionExtra },
): Promise<void> {
  const status = opts?.status ?? 200;
  const tokens = await issueDriverTokens(app, request, reply, driver.id);
  // The tokens go last, so nothing in extra can replace them.
  await reply
    .status(status)
    .send(tokens == null ? { driver, ...opts?.extra } : { driver, ...opts?.extra, ...tokens });
}
