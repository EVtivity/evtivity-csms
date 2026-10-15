// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Short-lived proof that a guest scanned a valid dynamic QR code (OCPP 2.1
 * C25). `POST /v1/portal/guest/qr/validate` issues it for a valid URL and
 * `POST /v1/portal/guest/start` requires it at a station with dynamic QR codes,
 * so a guest cannot skip the scan by opening the static charger URL.
 *
 * Format `v1.<expiry unix seconds>.<base64url HMAC-SHA256>`. The MAC covers the
 * version, the OCPP station identity, the EVSE id and the expiry, so a token
 * is valid only for the EVSE it was issued for. The key is derived from
 * JWT_SECRET with a fixed label: the token is not a JWT and can never pass as
 * an auth token, and no extra secret is needed.
 */

export const GUEST_QR_TOKEN_TTL_SECONDS = 10 * 60;

const VERSION = 'v1';
const KEY_LABEL = 'evtivity guest QR scan token v1';

function signingKey(): Buffer {
  return createHmac('sha256', config.JWT_SECRET).update(KEY_LABEL).digest();
}

function mac(stationId: string, evseId: number, expiresAtSeconds: number): Buffer {
  return createHmac('sha256', signingKey())
    .update(`${VERSION}|${stationId}|${String(evseId)}|${String(expiresAtSeconds)}`)
    .digest();
}

export interface GuestQrTarget {
  /** OCPP station identity. */
  stationId: string;
  evseId: number;
}

/** Signs a token for one EVSE, valid for GUEST_QR_TOKEN_TTL_SECONDS. */
export function signGuestQrToken(
  target: GuestQrTarget,
  nowMs: number = Date.now(),
): { token: string; expiresAt: Date } {
  const expiresAtSeconds = Math.floor(nowMs / 1000) + GUEST_QR_TOKEN_TTL_SECONDS;
  const signature = mac(target.stationId, target.evseId, expiresAtSeconds).toString('base64url');
  return {
    token: `${VERSION}.${String(expiresAtSeconds)}.${signature}`,
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

/** True when the token was issued for this EVSE and has not expired. */
export function verifyGuestQrToken(
  token: string | undefined,
  target: GuestQrTarget,
  nowMs: number = Date.now(),
): boolean {
  if (token == null || token === '') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const [, expiry = '', signature = ''] = parts;
  if (!/^\d{1,12}$/.test(expiry)) return false;
  const expiresAtSeconds = Number(expiry);
  if (expiresAtSeconds * 1000 <= nowMs) return false;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(target.stationId, target.evseId, expiresAtSeconds);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
