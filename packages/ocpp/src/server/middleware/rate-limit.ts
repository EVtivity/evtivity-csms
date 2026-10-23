// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-station inbound message rate limit. The OCPP server counts every frame a
 * station sends (CALL, CALLRESULT and CALLERROR) here before it logs or
 * processes the frame, so a station over the limit cannot fill the message log.
 */

export const DEFAULT_MAX_MESSAGES_PER_SECOND = 50;
/**
 * Inbound bytes per station per second. A frame can be 1 MiB, so 50
 * frames a second could carry 50 MiB; past this budget a frame is refused like
 * one past the frame limit.
 */
export const DEFAULT_MAX_BYTES_PER_SECOND = 2 * 1024 * 1024;
const WINDOW_MS = 1000;
const CLEANUP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

const stationCounters = new Map<string, { count: number; bytes: number; windowStart: number }>();

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
  /** Set when the frame is refused for the byte budget, not the frame count. */
  reason?: 'bytes';
}

/** Counts one inbound frame of a station against its per-second limits. */
export function consumeStationMessage(
  stationId: string,
  maxPerSecond: number = DEFAULT_MAX_MESSAGES_PER_SECOND,
  frameBytes = 0,
  maxBytesPerSecond: number = DEFAULT_MAX_BYTES_PER_SECOND,
): StationRateCheck {
  const now = Date.now();
  let counter = stationCounters.get(stationId);
  if (counter == null || now - counter.windowStart >= WINDOW_MS) {
    counter = { count: 0, bytes: 0, windowStart: now };
    stationCounters.set(stationId, counter);
  }
  counter.count++;
  counter.bytes += frameBytes;
  if (counter.count > maxPerSecond) return { allowed: false, count: counter.count };
  if (counter.bytes > maxBytesPerSecond) {
    return { allowed: false, count: counter.count, reason: 'bytes' };
  }
  return { allowed: true, count: counter.count };
}
