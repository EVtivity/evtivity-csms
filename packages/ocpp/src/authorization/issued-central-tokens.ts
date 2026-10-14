// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Central idTokens the CSMS issued to a station: the idToken of type Central
 * in a RequestStartTransaction or ReserveNow it sent (a portal or guest start,
 * an operator remote start, a reservation without a driver token). OCPP 2.1
 * Authorize accepts an unknown Central token only when it is one of these (or
 * a drv_ driver id): a station should never Authorize a Central token
 * (C05.FR.01), so any other unknown Central token is answered Invalid.
 *
 * Kept in memory per OCPP process: a station keeps its WebSocket on one
 * process, the process that sends it the command (the command listener skips
 * stations another process owns), so its Authorize reaches the same process.
 * After a restart a pending id is forgotten and Authorize answers Invalid;
 * the station is not supposed to send that Authorize in the first place.
 */

const START_TTL_MS = 15 * 60 * 1000;
const RESERVATION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED = 10_000;
const issued = new Map<string, number>();

function key(stationId: string, idToken: string): string {
  return `${stationId}\u0000${idToken}`;
}

/** The Central idToken of a CSMS command, or null. */
function centralIdToken(action: string, payload: Record<string, unknown>): string | null {
  if (action !== 'RequestStartTransaction' && action !== 'ReserveNow') return null;
  const idToken = payload['idToken'] as Record<string, unknown> | undefined;
  if (idToken?.['type'] !== 'Central') return null;
  const value = idToken['idToken'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Remembers the Central idToken of a RequestStartTransaction or ReserveNow sent to a station. */
export function rememberIssuedCentralToken(
  stationId: string,
  action: string,
  payload: Record<string, unknown>,
  now: number = Date.now(),
): void {
  const idToken = centralIdToken(action, payload);
  if (idToken == null) return;
  let ttl = START_TTL_MS;
  if (action === 'ReserveNow') {
    const raw = payload['expiryDateTime'];
    const expiry = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    ttl = Number.isFinite(expiry)
      ? Math.min(Math.max(expiry - now, START_TTL_MS), RESERVATION_MAX_TTL_MS)
      : RESERVATION_MAX_TTL_MS;
  }
  if (issued.size >= MAX_REMEMBERED) {
    for (const [k, until] of issued) if (until <= now) issued.delete(k);
    if (issued.size >= MAX_REMEMBERED) {
      const oldest = issued.keys().next().value;
      if (oldest != null) issued.delete(oldest);
    }
  }
  issued.set(key(stationId, idToken), now + ttl);
}

/** True when the CSMS issued this Central idToken to this station and it has not aged out. */
export function isIssuedCentralToken(
  stationId: string,
  idToken: string,
  now: number = Date.now(),
): boolean {
  const until = issued.get(key(stationId, idToken));
  return until != null && until > now;
}

/** Test helper. */
export function clearIssuedCentralTokens(): void {
  issued.clear();
}
