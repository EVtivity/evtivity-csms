// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import {
  acceptReconnect,
  applyConfiguration,
  closeConnectionAndRefuse,
  collectQueuedTransactionEvents,
  describeTx,
  energyTransferStarted,
  offlineConfiguration,
  RETRY_BACKOFF_WAIT_MINIMUM_S,
  useCsmsHandler,
} from './offline-shared.js';
import { sleep } from '../../../../cs-test-helpers.js';

export const TC_E_40_CS: CsTestCase = {
  id: 'TC_E_40_CS',
  name: 'Offline Behaviour - Connection loss during transaction',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages while it is offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await applyConfiguration(ctx, offlineConfiguration(), steps);
    const txId = await energyTransferStarted(ctx, 'OCTT-TOKEN-001', steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };

    // Step 1-2: close the connection, refuse reconnects for RetryBackOffWaitMinimum
    closeConnectionAndRefuse(ctx);
    await sleep(RETRY_BACKOFF_WAIT_MINIMUM_S * 1000);
    if (!(await acceptReconnect(ctx, steps))) return { status: 'failed', durationMs: 0, steps };

    // Step 3-4: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    const valid = queued.filter(
      (m) => m['eventType'] === 'Updated' && m['meterValue'] != null && m['offline'] === true,
    );
    steps.push({
      step: 3,
      description:
        'All queued TransactionEventRequests: eventType Updated, meterValue, offline true',
      status: queued.length > 0 && valid.length === queued.length ? 'passed' : 'failed',
      expected: 'At least one queued message, all Updated with meterValue and offline true',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
