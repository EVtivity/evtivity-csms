// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('ocpi-cdr-request');

/**
 * Asks the OCPI server to push a session to its partner again (`ocpi_push`,
 * type `session`); a completed session then gets its CDR. Fail-open: the CDR
 * sweep issues the CDR of a completed roaming session without a CDR.
 */
export async function publishOcpiSessionPush(sessionId: string): Promise<void> {
  try {
    await getPubSub().publish('ocpi_push', JSON.stringify({ type: 'session', sessionId }));
  } catch (err) {
    logger.warn({ err, sessionId }, 'OCPI session push publish failed; the CDR sweep catches up');
  }
}

/**
 * Asks the OCPI server for a CDR job (`ocpi_push`, type `cdr`): the new CDR
 * of a reissued session (`sessionId` and its `generation`), or the push of a
 * stored CDR an operator retries (`cdrId` and the `retry` stamp). The OCPI
 * server adds the job to its own queue.
 *
 * Fail-open: the database already holds the request (superseded CDRs, a CDR
 * back to pending), and the OCPI CDR sweep finds it within minutes when this
 * message is lost.
 */
export async function publishOcpiCdrRequest(
  request: { sessionId: string; generation: number } | { cdrId: string; retry: string },
): Promise<void> {
  try {
    await getPubSub().publish('ocpi_push', JSON.stringify({ type: 'cdr', ...request }));
  } catch (err) {
    logger.warn({ err }, 'OCPI CDR request publish failed; the CDR sweep picks it up');
  }
}
