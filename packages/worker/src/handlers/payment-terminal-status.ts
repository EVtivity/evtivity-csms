// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { pollTerminalDevices } from '@evtivity/services/payment-terminal-flow';
import { PAYMENT_TEMPLATES_DIRS, terminalFlowDeps } from '../lib/payments.js';

/**
 * Cron `payment-terminal-status` (every 5 minutes): polls the device status
 * of active cloud terminals and alerts the operators about a terminal offline
 * for 15 minutes, once per offline period (features/payment-terminals.md).
 */
export async function paymentTerminalStatusHandler(log: Logger): Promise<void> {
  const result = await pollTerminalDevices({
    ...terminalFlowDeps(log),
    templatesDirs: PAYMENT_TEMPLATES_DIRS,
  });
  const level = result.errors > 0 ? 'warn' : 'info';
  log[level](
    {
      polled: result.polled,
      changed: result.changed,
      alerted: result.alerted,
      errors: result.errors,
    },
    'Payment terminal status poll completed',
  );
}
