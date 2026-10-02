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
  stopWhileOffline,
  TRANSACTION_DURATION_S,
  useCsmsHandler,
} from './offline-shared.js';

export const TC_E_44_CS: CsTestCase = {
  id: 'TC_E_44_CS',
  name: 'Offline Behaviour - Stop transaction during offline period',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages when the transaction stopped while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await applyConfiguration(ctx, offlineConfiguration(TRANSACTION_DURATION_S), steps);
    const token = 'OCTT-TOKEN-001';
    const txId = await energyTransferStarted(ctx, token, steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };

    // Step 1: close the connection and refuse reconnects
    closeConnectionAndRefuse(ctx);
    // Manual Actions: present the same idToken, disconnect the EV
    await stopWhileOffline(ctx, token);
    // Step 2: accept the reconnection
    if (!(await acceptReconnect(ctx, steps))) return { status: 'failed', durationMs: 0, steps };

    // Step 3-4: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    const ended = queued.find(
      (m) =>
        m['eventType'] === 'Ended' &&
        (m['transactionInfo'] as Record<string, unknown> | undefined)?.['transactionId'] === txId,
    );
    steps.push({
      step: 3,
      description: 'Queued TransactionEventRequests: all offline true, one Ended',
      status:
        queued.length > 0 && queued.every((m) => m['offline'] === true) && ended != null
          ? 'passed'
          : 'failed',
      expected: 'offline true on every message, eventType Ended for the transaction',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_45_CS: CsTestCase = {
  id: 'TC_E_45_CS',
  name: 'Offline Behaviour - Stop transaction during offline period - Same GroupId',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages when the transaction stopped while offline using same GroupId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const groupIdToken = { idToken: 'OCTT-GROUP-001', type: 'Central' };
    // Authorized with <Configured GroupIdToken>
    useCsmsHandler(ctx, { idTokenInfo: { status: 'Accepted', groupIdToken } });
    await applyConfiguration(ctx, offlineConfiguration(TRANSACTION_DURATION_S), steps);
    const token = 'OCTT-TOKEN-001';
    const token2 = 'OCTT-TOKEN-002';

    // Memory State: IdTokenLocalAuthList for <valid idtoken fields2> with <GroupIdToken>
    const list = await ctx.server.sendCommand('SendLocalList', {
      versionNumber: 1,
      updateType: 'Full',
      localAuthorizationList: [
        {
          idToken: { idToken: token2, type: 'ISO14443' },
          idTokenInfo: { status: 'Accepted', groupIdToken },
        },
      ],
    });
    steps.push({
      step: 0,
      description: 'Before: Memory State IdTokenLocalAuthList with GroupIdToken',
      status: list['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status ${String(list['status'])}`,
    });

    const txId = await energyTransferStarted(ctx, token, steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };

    // Step 1: close the connection and refuse reconnects
    closeConnectionAndRefuse(ctx);
    // Manual Actions: present <valid idtoken fields2>, disconnect the EV
    await stopWhileOffline(ctx, token2);
    // Step 2: accept the reconnection
    if (!(await acceptReconnect(ctx, steps))) return { status: 'failed', durationMs: 0, steps };

    // Step 3-4: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    const ended = queued.find(
      (m) =>
        m['eventType'] === 'Ended' &&
        (m['transactionInfo'] as Record<string, unknown> | undefined)?.['transactionId'] === txId,
    );
    steps.push({
      step: 3,
      description: 'Queued TransactionEventRequests: all offline true, one Ended',
      status:
        queued.length > 0 && queued.every((m) => m['offline'] === true) && ended != null
          ? 'passed'
          : 'failed',
      expected: 'offline true on every message, eventType Ended for the transaction',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
