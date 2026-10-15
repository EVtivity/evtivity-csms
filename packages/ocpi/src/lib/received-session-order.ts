// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Ordering guard for Sessions a CPO partner pushes to our eMSP receiver.
// Pushes can arrive out of order (retries, parallel workers on the CPO side),
// so a late update must not undo a newer one:
// - an update whose last_updated is older than the stored one is stale;
// - a session that reached a terminal status (COMPLETED, INVALID) never goes
//   back to PENDING, ACTIVE or RESERVATION, and INVALID ("will not be
//   billed") is never replaced by COMPLETED (design principle P5).

const TERMINAL = new Set(['COMPLETED', 'INVALID']);

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True when `incoming` may replace the stored session `current`. Both are the
 * full session objects (for a PATCH, `incoming` is the merged result).
 */
export function receivedSessionUpdateAllowed(
  current: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): boolean {
  const currentTime = timeOf(current['last_updated']);
  const incomingTime = timeOf(incoming['last_updated']);
  if (currentTime != null && incomingTime != null && incomingTime < currentTime) {
    return false;
  }

  const currentStatus = current['status'];
  const incomingStatus = incoming['status'];
  if (typeof currentStatus === 'string' && TERMINAL.has(currentStatus)) {
    if (typeof incomingStatus !== 'string' || !TERMINAL.has(incomingStatus)) return false;
    if (currentStatus === 'INVALID' && incomingStatus !== 'INVALID') return false;
  }
  return true;
}
