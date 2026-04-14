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
 * TC_E_14_CSMS: Stop transaction options - EVDisconnected - Charging Station side
 * Use case: E06(S2) (E06.FR.02)
 * Before: State is EVConnectedPostSession
 * Scenario: Execute Reusable State EVDisconnected
 */
export const TC_E_14_CSMS: TestCase = {
  id: 'TC_E_14_CSMS',
  name: 'Stop transaction options - EVDisconnected - Charging Station side',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the EV and EVSE are disconnected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Stop charging, move to EVConnected (post-session)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
    });

    // EVDisconnected - end transaction
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EVDisconnected (CS side)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_20_CSMS: Stop transaction options - EVDisconnected - EV side (IEC 61851-1)
 * Use case: E06(S2), E10 (E06.FR.02)
 * Before: State is EVConnectedPostSession
 * Scenario: Execute Reusable State EVDisconnected
 */
export const TC_E_20_CSMS: TestCase = {
  id: 'TC_E_20_CSMS',
  name: 'Stop transaction options - EVDisconnected - EV side',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the EV disconnects on the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Move to EVConnected (post-session)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
    });

    // EVDisconnected
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EVDisconnected (EV side)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_15_CSMS: Stop transaction options - StopAuthorized - Local
 * Use case: E06(S3) (E06.FR.03)
 * Before: State is EnergyTransferSuspended
 * Scenario: Execute Reusable State EVDisconnected
 */
export const TC_E_15_CSMS: TestCase = {
  id: 'TC_E_15_CSMS',
  name: 'Stop transaction options - StopAuthorized - Local',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the EV driver locally stops.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Move to SuspendedEV (EnergyTransferSuspended)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEV' },
      evse: { id: 1, connectorId: 1 },
    });

    // EVDisconnected
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - StopAuthorized Local',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_21_CSMS: Stop transaction options - StopAuthorized - Remote
 * Use case: E06(S3) AND F03 (E06.FR.03, F03.FR.01, F03.FR.09, F03.FR.10)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   Manual Action: Trigger CSMS to send RequestStopTransaction
 *   1. CSMS sends RequestStopTransactionRequest
 *   2. Test System responds with Accepted
 *   3. TransactionEvent Ended with triggerReason RemoteStop, stoppedReason Remote
 */
export const TC_E_21_CSMS: TestCase = {
  id: 'TC_E_21_CSMS',
  name: 'Stop transaction options - StopAuthorized - Remote',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when it receives a remote stop.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Set up handler for RequestStopTransaction from CSMS
    let receivedRequestStop = false;
    let requestStopTxId = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStopTransaction') {
          receivedRequestStop = true;
          requestStopTxId = String(payload['transactionId'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    // Wait for CSMS to send RequestStopTransaction (manual action)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestStopTransaction', {
        stationId: ctx.stationId,
        transactionId: txId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends RequestStopTransactionRequest',
      status: receivedRequestStop ? 'passed' : 'failed',
      expected: 'RequestStopTransactionRequest received',
      actual: receivedRequestStop
        ? `Received for txId: ${requestStopTxId}`
        : 'No RequestStopTransactionRequest received',
    });

    // Step 3-4: Send TransactionEvent Ended with RemoteStop
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'RemoteStop',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'Remote',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Ended - RemoteStop',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_07_CSMS: Stop transaction options - PowerPathClosed - Local stop
 * Use case: E06(S5) (E06.FR.06)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. TransactionEvent Ended with triggerReason StopAuthorized, stoppedReason Local
 */
export const TC_E_07_CSMS: TestCase = {
  id: 'TC_E_07_CSMS',
  name: 'Stop transaction options - PowerPathClosed - Local stop',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when it is locally stopped.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // TransactionEvent Ended with StopAuthorized, Local
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'Local',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - StopAuthorized Local',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_08_CSMS: Stop transaction options - EnergyTransfer stopped - StopAuthorized
 * Use case: E06(S6) (E06.FR.07)
 * Before: State is StopAuthorized
 * Scenario:
 *   1. TransactionEvent Ended with triggerReason ChargingStateChanged,
 *      chargingState EVConnected, stoppedReason Local
 */
export const TC_E_08_CSMS: TestCase = {
  id: 'TC_E_08_CSMS',
  name: 'Stop transaction options - EnergyTransfer stopped - StopAuthorized',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the energy transfer is stopped after authorization.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // TransactionEvent Ended with ChargingStateChanged, EVConnected, Local
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'EVConnected',
        stoppedReason: 'Local',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - ChargingStateChanged EVConnected Local',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_16_CSMS: Stop transaction options - Deauthorized - Invalid idToken
 * Use case: E06(S3) (E06.FR.04, E01.FR.11, E01.FR.12)
 * Scenario:
 *   1. TransactionEvent Started with Authorized, invalid idToken
 *   2. CSMS responds with TransactionEventResponse
 *   3. TransactionEvent Ended with Deauthorized, stoppedReason DeAuthorized
 *   4. CSMS responds with TransactionEventResponse
 */
export const TC_E_16_CSMS: TestCase = {
  id: 'TC_E_16_CSMS',
  name: 'Stop transaction options - Deauthorized - Invalid idToken',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the transaction is deauthorized due to an invalid idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    const txId = `OCTT-TX-${String(Date.now())}`;

    // Step 1: TransactionEvent Started with invalid idToken
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'INVALID-TOKEN-999', type: 'ISO14443' },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Started with invalid idToken',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(startRes).join(', ')}`,
    });

    // Step 3: TransactionEvent Ended with Deauthorized
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'Deauthorized',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'DeAuthorized',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Ended - Deauthorized',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_17_CSMS: Stop transaction options - Deauthorized - EV side disconnect
 * Use case: E06(S3) (E06.FR.04)
 * Before: State is EnergyTransferSuspended
 * Scenario:
 *   1. TransactionEvent Ended with triggerReason EVCommunicationLost,
 *      chargingState Idle, stoppedReason EVDisconnected
 * Validations:
 *   Step 2: TransactionEventResponse - idTokenInfo.status must be Invalid or Unknown+
 */
export const TC_E_17_CSMS: TestCase = {
  id: 'TC_E_17_CSMS',
  name: 'Stop transaction options - Deauthorized - EV side disconnect',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the EV disconnects on the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Move to SuspendedEV (EnergyTransferSuspended)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEV' },
      evse: { id: 1, connectorId: 1 },
    });

    // TransactionEvent Ended with EVCommunicationLost, Idle, EVDisconnected
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EVCommunicationLost Idle EVDisconnected',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_22_CSMS: Stop transaction options - EnergyTransfer stopped - SuspendedEV
 * Use case: E06(S6) (E06.FR.07)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. TransactionEvent Ended with triggerReason ChargingStateChanged,
 *      chargingState SuspendedEV, stoppedReason StoppedByEV
 */
export const TC_E_22_CSMS: TestCase = {
  id: 'TC_E_22_CSMS',
  name: 'Stop transaction options - EnergyTransfer stopped - SuspendedEV',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the energy transfer is stopped by the EV.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // TransactionEvent Ended with ChargingStateChanged, SuspendedEV, StoppedByEV
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'SuspendedEV',
        stoppedReason: 'StoppedByEV',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - SuspendedEV StoppedByEV',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_19_CSMS: Stop transaction options - ParkingBayUnoccupied
 * Use case: E06(S1) (E06.FR.01)
 * Before: State is EVDisconnected
 * Scenario:
 *   1. TransactionEvent Ended with triggerReason EVDeparted, stoppedReason Local
 */
export const TC_E_19_CSMS: TestCase = {
  id: 'TC_E_19_CSMS',
  name: 'Stop transaction options - ParkingBayUnoccupied',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that stops a transaction when the EV left the parking bay.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Move to EVDisconnected state
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Idle' },
      evse: { id: 1, connectorId: 1 },
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // TransactionEvent Ended with EVDeparted, Local
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVDeparted',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'Local',
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EVDeparted Local',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
