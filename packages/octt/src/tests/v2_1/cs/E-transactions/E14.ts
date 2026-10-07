// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { sleep, waitForChargingState } from '../../../../cs-test-helpers.js';
import {
  acceptReconnect,
  applyConfiguration,
  closeConnectionAndRefuse,
  collectQueuedTransactionEvents,
  describeTx,
  energyTransferStarted,
  offlineConfiguration,
  RETRY_BACKOFF_WAIT_MINIMUM_S,
  stopWhileOffline,
  TRANSACTION_DURATION_S,
  useCsmsHandler,
} from './offline-shared.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    return {};
  });
}

export const TC_E_28_CS: CsTestCase = {
  id: 'TC_E_28_CS',
  name: 'Check Transaction status - TransactionId unknown',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to handle receiving a GetTransactionStatusRequest for an unknown transactionId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1: CSMS sends GetTransactionStatus with random transactionId
    const resp = await ctx.server.sendCommand('GetTransactionStatus', {
      transactionId: `UNKNOWN-TX-${String(Date.now())}`,
    });
    const respPayload = resp as Record<string, unknown> | null;
    const ongoing = respPayload?.['ongoingIndicator'] as boolean | undefined;
    const inQueue = respPayload?.['messagesInQueue'] as boolean | undefined;

    steps.push({
      step: 2,
      description: 'GetTransactionStatusResponse - unknown transaction',
      status: ongoing === false && inQueue === false ? 'passed' : 'failed',
      expected: 'ongoingIndicator false, messagesInQueue false',
      actual: `ongoingIndicator=${ongoing}, messagesInQueue=${inQueue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_29_CS: CsTestCase = {
  id: 'TC_E_29_CS',
  name: 'Check Transaction status - Transaction with id ongoing - with message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest with an ongoing transaction and queued messages.',
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

    // Step 3-4: GetTransactionStatus the moment the connection is restored
    const resp = await ctx.server.sendCommand('GetTransactionStatus', { transactionId: txId });
    steps.push({
      step: 4,
      description: 'GetTransactionStatusResponse - ongoing transaction with queued messages',
      status:
        resp['ongoingIndicator'] === true && resp['messagesInQueue'] === true ? 'passed' : 'failed',
      expected: 'ongoingIndicator true, messagesInQueue true',
      actual: `ongoingIndicator=${String(resp['ongoingIndicator'])}, messagesInQueue=${String(resp['messagesInQueue'])}`,
    });

    // Step 5-6: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    const valid = queued.filter(
      (m) => m['eventType'] === 'Updated' && m['meterValue'] != null && m['offline'] === true,
    );
    steps.push({
      step: 5,
      description: 'Queued TransactionEventRequest: eventType Updated, meterValue, offline true',
      status: queued.length > 0 && valid.length === queued.length ? 'passed' : 'failed',
      expected: 'At least one queued message, all Updated with meterValue and offline true',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_30_CS: CsTestCase = {
  id: 'TC_E_30_CS',
  name: 'Check Transaction status - Transaction with id ongoing - without message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest with an ongoing transaction and no queued messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: State is EnergyTransferStarted - start a transaction first
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Find TransactionEvent with chargingState Charging (skips setup messages)
    const chargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const txInfo30 = chargingMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const activeTxId = txInfo30?.['transactionId'] as string | undefined;

    // Step 1: CSMS sends GetTransactionStatus
    const resp = await ctx.server.sendCommand('GetTransactionStatus', {
      transactionId: activeTxId ?? 'UNKNOWN',
    });
    const respPayload = resp as Record<string, unknown> | null;
    const ongoing = respPayload?.['ongoingIndicator'] as boolean | undefined;
    const inQueue = respPayload?.['messagesInQueue'] as boolean | undefined;

    steps.push({
      step: 2,
      description: 'GetTransactionStatusResponse - ongoing without queue',
      status: ongoing === true && inQueue === false ? 'passed' : 'failed',
      expected: 'ongoingIndicator true, messagesInQueue false',
      actual: `ongoingIndicator=${ongoing}, messagesInQueue=${inQueue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_31_CS: CsTestCase = {
  id: 'TC_E_31_CS',
  name: 'Check Transaction status - Transaction with id ended - with message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest with an ended transaction and queued messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await applyConfiguration(
      ctx,
      [
        ...offlineConfiguration(TRANSACTION_DURATION_S),
        { component: 'TxCtrlr', variable: 'StopTxOnEVSideDisconnect', value: 'true' },
      ],
      steps,
    );
    const token = 'OCTT-TOKEN-001';
    const txId = await energyTransferStarted(ctx, token, steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };

    // The Test System closes the connection and does not accept a reconnect.
    closeConnectionAndRefuse(ctx);
    // Scenario local: present the same idToken, disconnect the EV, wait.
    await stopWhileOffline(ctx, token);
    if (!(await acceptReconnect(ctx, steps))) return { status: 'failed', durationMs: 0, steps };

    // Step 1-2: GetTransactionStatus the moment the connection is restored
    const resp = await ctx.server.sendCommand('GetTransactionStatus', { transactionId: txId });
    steps.push({
      step: 2,
      description: 'GetTransactionStatusResponse - ended transaction with queued messages',
      status:
        resp['ongoingIndicator'] === false && resp['messagesInQueue'] === true
          ? 'passed'
          : 'failed',
      expected: 'ongoingIndicator false, messagesInQueue true',
      actual: `ongoingIndicator=${String(resp['ongoingIndicator'])}, messagesInQueue=${String(resp['messagesInQueue'])}`,
    });

    // Step 3-4: all TransactionEventRequests of the transaction, StopAuthorized through the end
    const queued = await collectQueuedTransactionEvents(ctx);
    const ofTx = queued.filter(
      (m) =>
        (m['transactionInfo'] as Record<string, unknown> | undefined)?.['transactionId'] === txId,
    );
    const ended = ofTx.find((m) => m['eventType'] === 'Ended');
    const stopAuthorized = ofTx.some((m) => m['triggerReason'] === 'StopAuthorized');
    steps.push({
      step: 3,
      description:
        'Queued TransactionEventRequests: offline true, StopAuthorized and Ended for the transaction',
      status:
        queued.length > 0 &&
        queued.every((m) => m['offline'] === true) &&
        stopAuthorized &&
        ended != null
          ? 'passed'
          : 'failed',
      expected: 'All offline true, one with triggerReason StopAuthorized, one with eventType Ended',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_32_CS: CsTestCase = {
  id: 'TC_E_32_CS',
  name: 'Check Transaction status - Transaction with id ended - without message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest with an ended transaction and no queued messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: State is EnergyTransferStarted then ParkingBayUnoccupied - complete a full transaction
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Find TransactionEvent with chargingState Charging to capture transactionId
    const chargingMsg32 = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const txInfo32 = chargingMsg32?.['transactionInfo'] as Record<string, unknown> | undefined;
    const endedTxId = txInfo32?.['transactionId'] as string | undefined;
    await ctx.station.stopCharging(1, 'Local');
    await ctx.server.waitForMessageOrNull('TransactionEvent', 5000);
    await ctx.station.unplug(1);
    await ctx.server.waitForMessageOrNull('TransactionEvent', 5000);

    const resp = await ctx.server.sendCommand('GetTransactionStatus', {
      transactionId: endedTxId ?? 'UNKNOWN',
    });
    const respPayload = resp as Record<string, unknown> | null;
    const ongoing = respPayload?.['ongoingIndicator'] as boolean | undefined;
    const inQueue = respPayload?.['messagesInQueue'] as boolean | undefined;

    steps.push({
      step: 2,
      description: 'GetTransactionStatusResponse - ended without queue',
      status: ongoing === false && inQueue === false ? 'passed' : 'failed',
      expected: 'ongoingIndicator false, messagesInQueue false',
      actual: `ongoingIndicator=${ongoing}, messagesInQueue=${inQueue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_33_CS: CsTestCase = {
  id: 'TC_E_33_CS',
  name: 'Check Transaction status - Without transactionId - with message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest without a transactionId and with queued messages.',
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

    // Step 3-4: GetTransactionStatus without transactionId
    const resp = await ctx.server.sendCommand('GetTransactionStatus', {});
    steps.push({
      step: 4,
      description: 'GetTransactionStatusResponse - no transactionId with queued messages',
      status:
        resp['ongoingIndicator'] === undefined && resp['messagesInQueue'] === true
          ? 'passed'
          : 'failed',
      expected: 'ongoingIndicator omitted, messagesInQueue true',
      actual: `ongoingIndicator=${String(resp['ongoingIndicator'])}, messagesInQueue=${String(resp['messagesInQueue'])}`,
    });

    // Step 5-6: the station empties its transaction message queue
    const queued = await collectQueuedTransactionEvents(ctx);
    const valid = queued.filter(
      (m) => m['eventType'] === 'Updated' && m['meterValue'] != null && m['offline'] === true,
    );
    steps.push({
      step: 5,
      description: 'Queued TransactionEventRequest: eventType Updated, meterValue, offline true',
      status: queued.length > 0 && valid.length === queued.length ? 'passed' : 'failed',
      expected: 'At least one queued message, all Updated with meterValue and offline true',
      actual: queued.length === 0 ? 'none' : queued.map(describeTx).join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_34_CS: CsTestCase = {
  id: 'TC_E_34_CS',
  name: 'Check Transaction status - Without transactionId - without message in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the Charging Station is able to correctly respond to a GetTransactionStatusRequest without a transactionId and without queued messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const resp = await ctx.server.sendCommand('GetTransactionStatus', {});
    const respPayload = resp as Record<string, unknown> | null;
    const ongoing = respPayload?.['ongoingIndicator'];
    const inQueue = respPayload?.['messagesInQueue'] as boolean | undefined;

    steps.push({
      step: 2,
      description: 'GetTransactionStatusResponse - no txId, no queue',
      status: ongoing === undefined && inQueue === false ? 'passed' : 'failed',
      expected: 'ongoingIndicator omitted, messagesInQueue false',
      actual: `ongoingIndicator=${ongoing}, messagesInQueue=${inQueue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
