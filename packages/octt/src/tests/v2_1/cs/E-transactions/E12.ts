// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import {
  acceptReconnect,
  closeConnectionAndRefuse,
  collectQueuedTransactionEvents,
  describeTx,
  stopWhileOffline,
  TX_UPDATED_INTERVAL_S,
  useCsmsHandler,
} from './offline-shared.js';
import { sleep } from '../../../../cs-test-helpers.js';

export const TC_E_43_CS: CsTestCase = {
  id: 'TC_E_43_CS',
  name: 'Offline Behaviour - Transaction during offline period',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages while it was offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const token = 'OCTT-TOKEN-001';

    // Memory State: IdTokenLocalAuthList for the valid idToken
    const list = await ctx.server.sendCommand('SendLocalList', {
      versionNumber: 1,
      updateType: 'Full',
      localAuthorizationList: [
        { idToken: { idToken: token, type: 'ISO14443' }, idTokenInfo: { status: 'Accepted' } },
      ],
    });
    steps.push({
      step: 0,
      description: 'Before: Memory State IdTokenLocalAuthList (SendLocalListRequest)',
      status: list['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status ${String(list['status'])}`,
    });

    // Reusable State TransactionEventsInQueueEnded
    closeConnectionAndRefuse(ctx);
    await ctx.station.plugIn(1); // Manual Action: Connect the EV and EVSE.
    await ctx.station.authorize(1, token); // Manual Action: Present idToken.
    await sleep(TX_UPDATED_INTERVAL_S * 1000);
    await stopWhileOffline(ctx, token);
    if (!(await acceptReconnect(ctx, steps))) return { status: 'failed', durationMs: 0, steps };

    // Step 1-2: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    steps.push({
      step: 1,
      description: 'All queued TransactionEventRequests have offline true',
      status: queued.length > 0 && queued.every((m) => m['offline'] === true) ? 'passed' : 'failed',
      expected: 'offline true on every message',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });
    steps.push({
      step: 1,
      description: 'One queued message has eventType Started, one has eventType Ended',
      status:
        queued.some((m) => m['eventType'] === 'Started') &&
        queued.some((m) => m['eventType'] === 'Ended')
          ? 'passed'
          : 'failed',
      expected: 'Started and Ended',
      actual: queued.map((m) => String(m['eventType'])).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
