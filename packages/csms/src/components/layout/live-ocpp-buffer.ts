// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The lines of the live OCPP window: a bounded, ordered buffer fed by polling. */

/** Lines the window keeps; older ones fall off the top. */
export const LIVE_OCPP_MAX_LINES = 500;
/** Lines loaded when the window opens or the station filter changes. */
export const LIVE_OCPP_HISTORY = 100;
/** Lines one poll may add. */
export const LIVE_OCPP_POLL_LIMIT = 200;
/** How often the open window asks for new lines. */
export const LIVE_OCPP_POLL_MS = 2000;
/**
 * Each poll asks again for this much time before the newest line, so a row
 * an OCPP process committed a moment late still shows; repeats are dropped by id.
 */
export const LIVE_OCPP_OVERLAP_MS = 5000;

export interface LiveOcppLine {
  id: number;
  stationId: string;
  stationOcppId: string;
  direction: string;
  messageType: number;
  messageId: string | null;
  action: string | null;
  payload?: unknown;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
}

function byTime(a: LiveOcppLine, b: LiveOcppLine): number {
  const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return diff !== 0 ? diff : a.id - b.id;
}

/**
 * `current` with the `incoming` lines it does not hold yet, in time order,
 * the newest `max` kept. Lines with an id at or below `hiddenUpToId` (cleared
 * by the user) are left out.
 */
export function mergeLiveOcppLines(
  current: readonly LiveOcppLine[],
  incoming: readonly LiveOcppLine[],
  options: { max?: number; hiddenUpToId?: number } = {},
): LiveOcppLine[] {
  const max = options.max ?? LIVE_OCPP_MAX_LINES;
  const hidden = options.hiddenUpToId ?? 0;
  const seen = new Set(current.map((l) => l.id));
  const added = incoming.filter((l) => l.id > hidden && !seen.has(l.id));
  if (added.length === 0) return current.length > max ? current.slice(-max) : [...current];
  const merged = [...current, ...added].sort(byTime);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** The `after` of the next poll: the newest line seen less the overlap, else undefined. */
export function liveOcppCursor(newestAt: string | null): string | undefined {
  if (newestAt == null) return undefined;
  const at = Date.parse(newestAt);
  if (Number.isNaN(at)) return undefined;
  return new Date(at - LIVE_OCPP_OVERLAP_MS).toISOString();
}

/** The newest `createdAt` of `lines` and `incoming`, kept across Clear. */
export function newestLineAt(
  previous: string | null,
  incoming: readonly LiveOcppLine[],
): string | null {
  let newest = previous;
  for (const line of incoming) {
    if (newest == null || Date.parse(line.createdAt) > Date.parse(newest)) newest = line.createdAt;
  }
  return newest;
}
