// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isRoamingEnabled, touchExpiredDriverTokens } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/** Tokens per `ocpi_push` message, as the API sends them. */
const CHUNK = 500;

/**
 * Hourly: a driver token whose expiry passed is invalid for OCPI partners,
 * but nothing changed its row, so a partner pulling Tokens changed since its
 * last pull would not see it. `touchExpiredDriverTokens` moves its
 * updated_at once; then, with roaming on, the OCPI server pushes the token
 * (now valid = false) to the partners that receive Tokens. A lost publish is
 * covered by the pull. Runs whether or not roaming is on, so a partner that
 * connects later still pulls the right last_updated.
 */
export async function driverTokenExpiryHandler(log: Logger): Promise<void> {
  const tokenIds = await touchExpiredDriverTokens();
  if (tokenIds.length === 0) return;
  log.info({ tokens: tokenIds.length }, 'Expired driver tokens marked updated');

  if (!(await isRoamingEnabled())) return;
  const pubsub = getPubSub();
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    try {
      await pubsub.publish(
        'ocpi_push',
        JSON.stringify({ type: 'token', tokenIds: tokenIds.slice(i, i + CHUNK), tombstones: [] }),
      );
    } catch (err) {
      // fail-open: partners see the expiry on their next pull (last_updated moved).
      log.warn({ err }, 'OCPI token push publish failed; partners get it on their next pull');
    }
  }
}
