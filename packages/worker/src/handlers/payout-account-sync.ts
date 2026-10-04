// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { refreshAllPayoutAccounts } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';

/**
 * Daily read of every site payout account from Stripe (plan P3.5 Part C),
 * the third freshness layer after the `account.updated` webhook and the
 * operator refresh: a missed webhook never leaves a site refusing payments,
 * or accepting them after Stripe disabled the account, for more than a day.
 * One account's failure is logged and the others continue (P9).
 */
export async function payoutAccountSyncHandler(log: Logger): Promise<void> {
  const result = await refreshAllPayoutAccounts(paymentContext(log));
  if (result.total === 0) {
    log.debug('No payout accounts to sync');
    return;
  }
  log.info(
    { total: result.total, refreshed: result.refreshed, failed: result.failed },
    'Payout account sync complete',
  );
}
