// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send initial StatusNotification
async function bootAndStatus(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });
}

// Helper: start a charging transaction and return the txId
async function startChargingTransaction(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  const txId = `OCTT-TX-${String(Date.now())}`;
  await ctx.client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    evse: { id: 1, connectorId: 1 },
    idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
  });
  return txId;
}

/**
 * TC_E_29_CSMS: Check Transaction status - Transaction with id ongoing - with message in queue
 * Use case: E14 (E14.FR.02, E14.FR.04)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. Close WebSocket
 *   2. Wait configured duration, reconnect
 *   3. CSMS sends GetTransactionStatusRequest
 *   4. Respond with ongoingIndicator true, messagesInQueue true
 *   5. TransactionEvent Updated with offline true
 *   6. CSMS responds with TransactionEventResponse
 */
export const TC_E_29_CSMS: TestCase = {
  id: 'TC_E_29_CSMS',
  name: 'Check Transaction status - ongoing - with messages in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the CSMS is able to request the status of queued TransactionEventRequest messages from a reconnected Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Set up handler for GetTransactionStatus from CSMS
    let receivedGetTxStatus = false;
    let requestedTxId = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetTransactionStatus') {
          receivedGetTxStatus = true;
          requestedTxId = String(payload['transactionId'] ?? '');
          return { ongoingIndicator: true, messagesInQueue: true };
        }
        return { status: 'NotSupported' };
      },
    );

    // Wait for CSMS to send GetTransactionStatus after reconnect
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetTransactionStatus', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetTransactionStatusRequest',
      status: receivedGetTxStatus ? 'passed' : 'failed',
      expected: 'GetTransactionStatusRequest received',
      actual: receivedGetTxStatus
        ? `Received for txId: ${requestedTxId}`
        : 'No GetTransactionStatusRequest received',
    });

    // Step 5: Send offline TransactionEvent Updated
    const updateRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 1,
      offline: true,
      transactionInfo: { transactionId: txId },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 1000,
              measurand: 'Energy.Active.Import.Register',
              unitOfMeasure: { unit: 'Wh' },
            },
          ],
        },
      ],
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated with offline meter values',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(updateRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_30_CSMS: Check Transaction status - Transaction with id ongoing - without message in queue
 * Use case: E14 (E14.FR.02, E14.FR.05)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. CSMS sends GetTransactionStatusRequest
 *   2. Respond with ongoingIndicator true, messagesInQueue false
 * Validations:
 *   transactionId must be the transactionId from before
 */
export const TC_E_30_CSMS: TestCase = {
  id: 'TC_E_30_CSMS',
  name: 'Check Transaction status - ongoing - without messages in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the CSMS is able to request the status of queued TransactionEventRequest messages from a Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    let receivedGetTxStatus = false;
    let requestedTxId = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetTransactionStatus') {
          receivedGetTxStatus = true;
          requestedTxId = String(payload['transactionId'] ?? '');
          return { ongoingIndicator: true, messagesInQueue: false };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetTransactionStatus', {
        stationId: ctx.stationId,
        transactionId: txId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetTransactionStatusRequest',
      status: receivedGetTxStatus ? 'passed' : 'failed',
      expected: 'GetTransactionStatusRequest received',
      actual: receivedGetTxStatus
        ? `Received for txId: ${requestedTxId}`
        : 'No GetTransactionStatusRequest received',
    });

    // Validate transactionId matches
    steps.push({
      step: 2,
      description: 'Validate transactionId matches the one from Before state',
      status: requestedTxId === txId ? 'passed' : 'failed',
      expected: txId,
      actual: requestedTxId,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_31_CSMS: Check Transaction status - Transaction with id ended - with message in queue
 * Use case: E14 (E14.FR.03, E14.FR.04)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. Close WebSocket
 *   2. Wait, reconnect
 *   3. StatusNotification Available
 *   4. CSMS responds
 *   5. TransactionEvent Ended offline with seqNo skip
 *   6. CSMS responds
 *   7. CSMS sends GetTransactionStatusRequest
 *   8. Respond with ongoingIndicator false, messagesInQueue true
 *   9-12. Offline TransactionEvent Updated messages (skipped seqNos)
 */
export const TC_E_31_CSMS: TestCase = {
  id: 'TC_E_31_CSMS',
  name: 'Check Transaction status - ended - with messages in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the CSMS is able to request the status of queued TransactionEventRequest messages from a reconnected Charging Station after the transaction ended offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Set up handler for GetTransactionStatus
    let receivedGetTxStatus = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'GetTransactionStatus') {
        receivedGetTxStatus = true;
        return { ongoingIndicator: false, messagesInQueue: true };
      }
      return { status: 'NotSupported' };
    });

    // Step 3: StatusNotification Available (after reconnect)
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 5: TransactionEvent Ended offline (seqNo 3, skipping 1 and 2)
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 3,
      offline: true,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended offline',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    // Wait for CSMS to send GetTransactionStatus
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetTransactionStatus', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends GetTransactionStatusRequest',
      status: receivedGetTxStatus ? 'passed' : 'failed',
      expected: 'GetTransactionStatusRequest received',
      actual: receivedGetTxStatus
        ? 'GetTransactionStatusRequest received'
        : 'No GetTransactionStatusRequest received',
    });

    // Step 9: Offline TransactionEvent Updated (seqNo 1 - first skipped value)
    const update1Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      offline: true,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 3,
      description: 'Offline TransactionEvent Updated seqNo 1',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(update1Res).join(', ')}`,
    });

    // Step 11: Offline TransactionEvent Updated (seqNo 2 - second skipped value)
    const update2Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 2,
      offline: true,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 4,
      description: 'Offline TransactionEvent Updated seqNo 2',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(update2Res).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_33_CSMS: Check Transaction status - Without transactionId - with message in queue
 * Use case: E14 (E14.FR.06, E14.FR.07)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. Close WebSocket
 *   2. Wait, reconnect
 *   3. CSMS sends GetTransactionStatusRequest (without transactionId)
 *   4. Respond with ongoingIndicator omitted, messagesInQueue true
 *   5. TransactionEvent Updated with offline true
 */
export const TC_E_33_CSMS: TestCase = {
  id: 'TC_E_33_CSMS',
  name: 'Check Transaction status - without transactionId - with messages in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the CSMS is able to request the status of queued TransactionEventRequest messages by sending a request without transactionId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    let receivedGetTxStatus = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'GetTransactionStatus') {
          receivedGetTxStatus = true;
          return { messagesInQueue: true };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetTransactionStatus', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetTransactionStatusRequest',
      status: receivedGetTxStatus ? 'passed' : 'failed',
      expected: 'GetTransactionStatusRequest received',
      actual: receivedGetTxStatus
        ? 'GetTransactionStatusRequest received'
        : 'No GetTransactionStatusRequest received',
    });

    // Send offline TransactionEvent Updated
    const updateRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 1,
      offline: true,
      transactionInfo: { transactionId: txId },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 1000,
              measurand: 'Energy.Active.Import.Register',
              unitOfMeasure: { unit: 'Wh' },
            },
          ],
        },
      ],
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated with offline meter values',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(updateRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_34_CSMS: Check Transaction status - Without transactionId - without message in queue
 * Use case: E14 (E14.FR.06, E14.FR.08)
 * Scenario:
 *   1. CSMS sends GetTransactionStatusRequest (transactionId must be omitted)
 *   2. Respond with ongoingIndicator omitted, messagesInQueue false
 */
export const TC_E_34_CSMS: TestCase = {
  id: 'TC_E_34_CSMS',
  name: 'Check Transaction status - without transactionId - without messages in queue',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to request the status of a transaction and to find out whether there are queued messages.',
  purpose:
    'To verify if the CSMS is able to request the status of queued TransactionEventRequest messages by sending a request without transactionId when no messages are queued.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedGetTxStatus = false;
    let transactionIdOmitted = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetTransactionStatus') {
          receivedGetTxStatus = true;
          transactionIdOmitted = payload['transactionId'] == null;
          return { messagesInQueue: false };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetTransactionStatus', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetTransactionStatusRequest',
      status: receivedGetTxStatus ? 'passed' : 'failed',
      expected: 'GetTransactionStatusRequest received',
      actual: receivedGetTxStatus
        ? 'GetTransactionStatusRequest received'
        : 'No GetTransactionStatusRequest received',
    });

    steps.push({
      step: 2,
      description: 'transactionId must be omitted',
      status: transactionIdOmitted ? 'passed' : 'failed',
      expected: 'transactionId omitted',
      actual: transactionIdOmitted ? 'transactionId omitted' : 'transactionId was present',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
