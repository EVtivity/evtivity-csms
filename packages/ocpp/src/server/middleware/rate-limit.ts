// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-station inbound message rate limit. The OCPP server counts every frame a
 * station sends (CALL, CALLRESULT and CALLERROR) here before it logs or
 * processes the frame, so a station over the limit cannot fill the message log.
 */

export const DEFAULT_MAX_MESSAGES_PER_SECOND = 50;
const WINDOW_MS = 1000;
const CLEANUP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

const stationCounters = new Map<string, { count: number; windowStart: number }>();

// Periodic cleanup of stale entries from disconnected stations
setInterval(() => {
  const now = Date.now();
  for (const [stationId, counter] of stationCounters) {
    if (now - counter.windowStart > STALE_THRESHOLD_MS) {
      stationCounters.delete(stationId);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export interface StationRateCheck {
  /** False when the frame is over the station's limit for this one-second window. */
  allowed: boolean;
  /** Frames counted in the current window, this one included. */
  count: number;
}

/** Counts one inbound frame of a station against its per-second limit. */
export function consumeStationMessage(
  stationId: string,
  maxPerSecond: number = DEFAULT_MAX_MESSAGES_PER_SECOND,
): StationRateCheck {
  const now = Date.now();
  let counter = stationCounters.get(stationId);
  if (counter == null || now - counter.windowStart >= WINDOW_MS) {
    counter = { count: 0, windowStart: now };
    stationCounters.set(stationId, counter);
  }
  counter.count++;
  return { allowed: counter.count <= maxPerSecond, count: counter.count };
}
