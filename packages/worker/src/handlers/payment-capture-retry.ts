// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { retryShortfalls } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';

/**
 * Daily retry of capture shortfalls: records whose top-up (the final cost
 * above the hold) was declined are `captured` with a `Top-up declined:`
 * reason. The top-up is charged again on the same card and payout account
 * with the key `topup_retry_<paymentId>_<captured>`, shared with the operator
 * retry; a record still declined keeps the new reason for the next run.
 */
export async function paymentCaptureRetryHandler(log: Logger): Promise<void> {
  const result = await retryShortfalls(paymentContext(log));
  if (result.total === 0) {
    log.debug('No payment records with capture shortfall to retry');
    return;
  }
  log.info(
    {
      recovered: result.recovered,
      stillFailed: result.stillFailed,
      notCollectable: result.notCollectable,
      total: result.total,
    },
    'Capture retry pass complete',
  );
}
