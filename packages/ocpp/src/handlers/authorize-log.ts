// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, authorizeAttempts } from '@evtivity/database';
import type { Logger, PubSubClient } from '@evtivity/lib';

// Set once at OCPP server startup so the forensic insert can fan out an SSE
// notification. Null in tests and until the server wires it up; publish is
// skipped when null.
let pubsub: PubSubClient | null = null;

export function setAuthorizeLogPubSub(client: PubSubClient): void {
  pubsub = client;
}

/**
 * Pull `valid_thru` out of an OCPI Token's tokenData JSONB. OCPI 2.2.1+ tokens
 * may include an ISO 8601 datetime here that the eMSP set as the upstream
 * expiry. When present and in the past, the token is expired regardless of
 * `is_valid`. Returns null when the field is missing or unparseable.
 */
export function parseOcpiValidThru(tokenData: unknown): Date | null {
  if (tokenData == null || typeof tokenData !== 'object') return null;
  const raw = (tokenData as Record<string, unknown>)['valid_thru'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export type AuthorizeOutcome =
  | 'accepted'
  | 'invalid'
  | 'blocked'
  | 'expired'
  | 'no_credit'
  | 'concurrent_tx'
  | 'unknown'
  | 'db_error';

export async function logAuthorizeAttempt(
  args: {
    stationId: string | null;
    idToken: string;
    tokenType: string | null;
    matchedTokenId?: string | null;
    matchedDriverId?: string | null;
    outcome: AuthorizeOutcome;
    ocppVersion: 'ocpp1.6' | 'ocpp2.1';
    reason?: string | null;
  },
  logger: Logger,
): Promise<void> {
  // Logging is best-effort. A failure to record the attempt must not break
  // the handler response that the station is waiting for.
  try {
    await db.insert(authorizeAttempts).values({
      stationId: args.stationId,
      idToken: args.idToken,
      tokenType: args.tokenType,
      matchedTokenId: args.matchedTokenId ?? null,
      matchedDriverId: args.matchedDriverId ?? null,
      outcome: args.outcome,
      ocppVersion: args.ocppVersion,
      reason: args.reason ?? null,
    });
  } catch (err) {
    logger.warn({ err, ...args }, 'Failed to record authorize attempt');
    return;
  }

  // Tell the CSMS so the Authorize Log page reloads itself. Best-effort: a
  // publish failure must not break the station's authorize response.
  if (pubsub != null) {
    try {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({
          eventType: 'authorize.attempt',
          stationId: args.stationId,
          siteId: null,
          sessionId: null,
        }),
      );
    } catch (err) {
      logger.debug({ err }, 'authorize.attempt SSE publish failed; continuing');
    }
  }
}
