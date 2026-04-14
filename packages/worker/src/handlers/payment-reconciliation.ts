// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, paymentReconciliationRuns } from '@evtivity/database';
import type { Logger } from 'pino';
import { reconcilePayments } from '@evtivity/api/src/services/payment-reconciliation.service.js';

export async function paymentReconciliationHandler(log: Logger): Promise<void> {
  const result = await reconcilePayments(log);

  // Store the run result
  await db.insert(paymentReconciliationRuns).values({
    checkedCount: result.checked,
    matchedCount: result.matched,
    discrepancyCount: result.discrepancies.length,
    errorCount: result.errors.length,
    discrepancies: result.discrepancies,
    errors: result.errors.length > 0 ? result.errors : null,
  });

  if (result.discrepancies.length > 0) {
    log.warn(
      { discrepancies: result.discrepancies.length, checked: result.checked },
      'Payment reconciliation found discrepancies',
    );
  } else {
    log.info(
      { checked: result.checked, matched: result.matched },
      'Payment reconciliation completed',
    );
  }
}
