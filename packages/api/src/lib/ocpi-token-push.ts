// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isRoamingEnabled } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('ocpi-token-push');

/** Tokens per `ocpi_push` message, so a large import is several small messages. */
const CHUNK = 500;

/** A token value that no longer exists (deleted, or its value or type changed). */
export interface OcpiTokenTombstoneRef {
  idToken: string;
  tokenType: string;
}

/**
 * Asks the OCPI server to push driver tokens to the partners that receive
 * Tokens (`ocpi_push`, type `token`, OCPI 12.1.1 push model): the current
 * token for each id, and valid = false for each tombstone.
 *
 * Fail-open: the mutation already committed, and partners still see the
 * change on their next GET /emsp/tokens pull, since last_updated moved.
 */
export async function publishOcpiTokenPush(change: {
  tokenIds?: readonly string[];
  tombstones?: readonly OcpiTokenTombstoneRef[];
}): Promise<void> {
  const tokenIds = change.tokenIds ?? [];
  const tombstones = change.tombstones ?? [];
  if (tokenIds.length === 0 && tombstones.length === 0) return;
  try {
    if (!(await isRoamingEnabled())) return;
    const pubsub = getPubSub();
    for (let i = 0; i < Math.max(tokenIds.length, tombstones.length); i += CHUNK) {
      await pubsub.publish(
        'ocpi_push',
        JSON.stringify({
          type: 'token',
          tokenIds: tokenIds.slice(i, i + CHUNK),
          tombstones: tombstones.slice(i, i + CHUNK),
        }),
      );
    }
  } catch (err) {
    logger.warn({ err }, 'OCPI token push publish failed; partners get it on their next pull');
  }
}
