// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { reconcileTerminals } from '@evtivity/services/payment-terminal-flow';
import { PAYMENT_TEMPLATES_DIRS, terminalFlowDeps } from '../lib/payments.js';

/**
 * Cron `payment-terminal-reconcile` (every 5 minutes): resolves terminal
 * transactions a lost answer, webhook or process left in an intermediate
 * state (features/payment-terminals.md, P4 sweeper).
 */
export async function paymentTerminalReconcileHandler(log: Logger): Promise<void> {
  const result = await reconcileTerminals({
    ...terminalFlowDeps(log),
    templatesDirs: PAYMENT_TEMPLATES_DIRS,
  });
  const level = result.errors > 0 ? 'warn' : 'info';
  log[level](
    {
      lookedUp: result.lookedUp,
      voided: result.voided,
      settled: result.settled,
      errors: result.errors,
    },
    'Payment terminal reconciliation completed',
  );
}
