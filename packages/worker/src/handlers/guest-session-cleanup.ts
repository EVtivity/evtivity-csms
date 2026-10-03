// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { expireGuestSessions } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';

/**
 * Guest checkouts whose token expired before charging started: the hold is
 * cancelled (best effort) and the guest session marked expired.
 */
export async function guestSessionCleanupHandler(log: Logger): Promise<void> {
  const count = await expireGuestSessions(paymentContext(log));
  if (count > 0) {
    log.info({ count }, 'Expired guest sessions cleaned up');
  }
}
