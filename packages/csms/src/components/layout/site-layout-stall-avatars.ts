// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The driver avatars of a charger serving two or more stalls: one over each
// stall's vehicle, each from its own EVSE's session (the two charger cases,
// case A). The station's own avatar keeps the station id; another stall's
// avatar is keyed `<view id>@stall<n>` (n: the stall, the EVSE index).

const STALL_SEPARATOR = '@stall';

/** The overlay key of one stall's avatar. */
export function stallAvatarKey(viewId: string, stall: number): string {
  return `${viewId}${STALL_SEPARATOR}${String(stall)}`;
}

/** The view id and stall of an avatar key; no stall for a station's own avatar. */
export function parseAvatarKey(key: string): { viewId: string; stall?: number } {
  const at = key.lastIndexOf(STALL_SEPARATOR);
  if (at < 0) return { viewId: key };
  const stall = Number(key.slice(at + STALL_SEPARATOR.length));
  return Number.isInteger(stall) && stall >= 0
    ? { viewId: key.slice(0, at), stall }
    : { viewId: key };
}

/**
 * The sessions of a charger's other stalls: every EVSE (stall, EVSE order)
 * whose own session is not the station's, so each charging driver gets one
 * avatar. The scene places it only where it drew that stall's vehicle.
 */
export function otherStallSessions<S extends { id: string }>(station: {
  session?: { id: string } | null | undefined;
  evses: ReadonlyArray<{ session?: S | null | undefined }>;
}): Array<{ stall: number; session: S }> {
  const own = station.session?.id ?? null;
  return station.evses.flatMap((e, stall) =>
    e.session != null && e.session.id !== own ? [{ stall, session: e.session }] : [],
  );
}
