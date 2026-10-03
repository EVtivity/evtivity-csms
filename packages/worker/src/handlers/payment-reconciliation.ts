// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { runPaymentReconciliation } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';

export async function paymentReconciliationHandler(log: Logger): Promise<void> {
  const result = await runPaymentReconciliation(paymentContext(log));
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
