// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PubSubClient } from './pubsub.js';

/**
 * Cross-process cache invalidation channel. The API publishes here; every
 * OCPP process subscribes and clears the named in-memory cache.
 */
export const CACHE_INVALIDATE_CHANNEL = 'cache_invalidate';

/**
 * Message kind that evicts one station's cached connection authentication in
 * every OCPP process, after its password or security profile changed.
 */
export const STATION_AUTH_INVALIDATION_KIND = 'station_auth';

export function stationAuthInvalidationPayload(stationDbId: string): string {
  return JSON.stringify({ kind: STATION_AUTH_INVALIDATION_KIND, stationId: stationDbId });
}

/** The station database id of a station auth invalidation, or null for any other message. */
export function parseStationAuthInvalidation(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg == null) return null;
  const { kind, stationId } = msg as { kind?: unknown; stationId?: unknown };
  if (kind !== STATION_AUTH_INVALIDATION_KIND) return null;
  return typeof stationId === 'string' && stationId !== '' ? stationId : null;
}

interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Fail-open: the OCPP auth cache keys every entry on the stored password hash,
 * which it reads from the database on each connection, so a changed password
 * never matches an old entry even when this message is lost. The message
 * evicts the entry at once as a second layer.
 */
export async function publishStationAuthInvalidation(
  pubsub: PubSubClient,
  stationDbId: string,
  log: WarnLogger,
): Promise<void> {
  try {
    await pubsub.publish(CACHE_INVALIDATE_CHANNEL, stationAuthInvalidationPayload(stationDbId));
  } catch (err: unknown) {
    log.warn({ err, stationDbId }, 'Failed to publish station auth cache invalidation');
  }
}
