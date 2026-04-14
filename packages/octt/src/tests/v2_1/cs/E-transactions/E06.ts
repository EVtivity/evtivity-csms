// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import {
  waitForChargingState,
  waitForTransactionEventType,
  waitForTriggerReason,
} from '../../../../cs-test-helpers.js';

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

export const TC_E_16_CS: CsTestCase = {
  id: 'TC_E_16_CS',
  name: 'Stop transaction options - Deauthorized - Invalid idToken',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the transaction gets deauthorized by the status of the idToken being Invalid.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Set handler that returns Invalid for the idToken on TransactionEvent containing idToken
    ctx.server.setMessageHandler(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') {
        const idToken = payload['idToken'] as Record<string, unknown> | undefined;
        if (idToken) return { idTokenInfo: { status: 'Invalid' } };
        return {};
      }
      return {};
    });

    // Before: State is StartOfflineTransaction - station reconnects with queued messages
    // Setup: enable offline auth, go offline, start tx, reconnect
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted');
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await new Promise((r) => setTimeout(r, 200));
    ctx.server.acceptConnections();
    // Drain boot and status
    try {
      await ctx.server.waitForMessage('BootNotification', 10_000);
    } catch {
      /* ok */
    }
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    // Step 1: CS sends TransactionEvent (offline queue)
    const txMsg1 = await ctx.server.waitForMessage('TransactionEvent', 60000);
    const tx1Payload = txMsg1 as Record<string, unknown> | null;
    const offline1 = tx1Payload?.['offline'] as boolean | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent with offline true',
      status: offline1 === true ? 'passed' : 'failed',
      expected: 'offline must be true',
      actual: `offline=${offline1}`,
    });

    // Step 3: CS sends TransactionEvent Ended with Deauthorized
    const txMsg3 = await ctx.server.waitForMessage('TransactionEvent', 60000);
    const tx3Payload = txMsg3 as Record<string, unknown> | null;
    const evtType3 = tx3Payload?.['eventType'] as string | undefined;
    const trigReason3 = tx3Payload?.['triggerReason'] as string | undefined;
    const txInfo3 = tx3Payload?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason3 = txInfo3?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 3,
      description: 'TransactionEvent Ended with Deauthorized',
      status:
        evtType3 === 'Ended' && trigReason3 === 'Deauthorized' && stoppedReason3 === 'DeAuthorized'
          ? 'passed'
          : 'failed',
      expected: 'eventType Ended, triggerReason Deauthorized, stoppedReason DeAuthorized',
      actual: `eventType=${evtType3}, triggerReason=${trigReason3}, stoppedReason=${stoppedReason3}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_17_CS: CsTestCase = {
  id: 'TC_E_17_CS',
  name: 'Stop transaction options - Deauthorized - EV side disconnect',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the transaction gets deauthorized by a disconnect on the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains Authorized, StopTxOnEVSideDisconnect true, State is EnergyTransferSuspended

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Disconnect on EV side
    await ctx.station.unplug(1);

    // Step 1: TransactionEvent Ended with EVCommunicationLost
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with EVCommunicationLost',
      status:
        trigReason === 'EVCommunicationLost' &&
        chState === 'Idle' &&
        stoppedReason === 'EVDisconnected' &&
        txMsg != null
          ? 'passed'
          : 'failed',
      expected:
        'triggerReason EVCommunicationLost, chargingState Idle, stoppedReason EVDisconnected, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    // Drain leftover StatusNotifications
    for (let _d = 0; _d < 3; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    // Step 3: StatusNotification Available
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const connStatus = statusPayload?.['connectorStatus'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StatusNotification Available',
      status: connStatus === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus Available',
      actual: `connectorStatus=${connStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_39_CS: CsTestCase = {
  id: 'TC_E_39_CS',
  name: 'Stop transaction options - Deauthorized - timeout',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the transaction gets deauthorized because the EVConnectionTimeout expired.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains Authorized, EVConnectionTimeOut configured, State is Authorized
    ctx.station.setConfigValue('TxCtrlr.EVConnectionTimeOut', '3');
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    // Drain Authorize message
    try {
      await ctx.server.waitForMessage('Authorize', 2000);
    } catch {
      /* drain */
    }
    // Wait for timeout without plugging in

    // Step 1: TransactionEvent with EVConnectTimeout
    const txMsg1 = await waitForTriggerReason(ctx.server, 'EVConnectTimeout', 15_000);
    const tx1Payload = txMsg1 as Record<string, unknown> | null;
    const trigReason1 = tx1Payload?.['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent with EVConnectTimeout',
      status: trigReason1 === 'EVConnectTimeout' ? 'passed' : 'failed',
      expected: 'triggerReason EVConnectTimeout',
      actual: `triggerReason=${trigReason1}`,
    });

    // Now plug in cable
    await ctx.station.plugIn(1);

    // Step 3: StatusNotification Occupied (after cable connect)
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const connStatus = statusPayload?.['connectorStatus'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StatusNotification Occupied',
      status: connStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus Occupied',
      actual: `connectorStatus=${connStatus}`,
    });

    // Step 5: TransactionEvent - should not start charging
    let chargingStarted = false;
    try {
      const txMsg5 = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const tx5Payload = txMsg5 as Record<string, unknown> | null;
      const txInfo5 = tx5Payload?.['transactionInfo'] as Record<string, unknown> | undefined;
      const chState5 = txInfo5?.['chargingState'] as string | undefined;
      if (chState5 === 'Charging') chargingStarted = true;
    } catch {
      chargingStarted = false;
    }
    steps.push({
      step: 5,
      description: 'TransactionEvent - should not start charging',
      status: !chargingStarted ? 'passed' : 'failed',
      expected: 'chargingState should not be Charging',
      actual: chargingStarted ? 'Charging (unexpected)' : 'Not charging (correct)',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_07_CS: CsTestCase = {
  id: 'TC_E_07_CS',
  name: 'Stop transaction options - PowerPathClosed - Local stop',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when it is locally stopped by an EV driver and TxStopPoint is PowerPathClosed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains PowerPathClosed, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Present IdToken to stop charging session
    await ctx.station.stopCharging(1, 'Local');

    // Step 1: Execute Reusable State StopAuthorized
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'StopAuthorized - TransactionEvent Ended',
      status: trigReason === 'StopAuthorized' && txMsg != null ? 'passed' : 'failed',
      expected: 'triggerReason StopAuthorized, eventType Ended',
      actual: `triggerReason=${trigReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_35_CS: CsTestCase = {
  id: 'TC_E_35_CS',
  name: 'Stop transaction options - PowerPathClosed - Remote stop',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when it is remotely stopped by the CSMS and TxStopPoint is PowerPathClosed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains PowerPathClosed, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    const txId = await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Step 1: CSMS sends RequestStopTransaction
    const stopResp = await ctx.server.sendCommand('RequestStopTransaction', {
      transactionId: txId,
    });

    // Step 2: CS responds with Accepted
    const stopPayload = stopResp as Record<string, unknown> | null;
    const stopStatus = stopPayload?.['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'RequestStopTransactionResponse status Accepted',
      status: stopStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status=${stopStatus}`,
    });

    // Step 3: TransactionEvent Ended with RemoteStop
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 3,
      description: 'TransactionEvent Ended with RemoteStop',
      status:
        trigReason === 'RemoteStop' && stoppedReason === 'Remote' && txMsg != null
          ? 'passed'
          : 'failed',
      expected: 'triggerReason RemoteStop, stoppedReason Remote, eventType Ended',
      actual: `triggerReason=${trigReason}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_37_CS: CsTestCase = {
  id: 'TC_E_37_CS',
  name: 'Stop transaction options - PowerPathClosed - EV side disconnect',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV and the EVSE get disconnected and TxStopPoint is PowerPathClosed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains PowerPathClosed, StopTxOnEVSideDisconnect false, State is EnergyTransferSuspended

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Disconnect on EV side
    await ctx.station.unplug(1);

    // Step 1: TransactionEvent Ended with EVCommunicationLost
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with EVCommunicationLost',
      status:
        trigReason === 'EVCommunicationLost' &&
        chState === 'Idle' &&
        (stoppedReason === 'EVDisconnected' || stoppedReason === 'StoppedByEV') &&
        txMsg != null
          ? 'passed'
          : 'failed',
      expected:
        'triggerReason EVCommunicationLost, chargingState Idle, stoppedReason EVDisconnected/StoppedByEV, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_08_CS: CsTestCase = {
  id: 'TC_E_08_CS',
  name: 'Stop transaction options - EnergyTransfer stopped - StopAuthorized',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the energy transfer stopped normally and TxStopPoint is EnergyTransfer.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains EnergyTransfer, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Step 1: State is StopAuthorized - stop charging locally
    await ctx.station.stopCharging(1, 'Local');

    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    steps.push({
      step: 1,
      description: 'StopAuthorized - TransactionEvent received',
      status: txMsg != null ? 'passed' : 'failed',
      expected: 'TransactionEvent Ended or Updated',
      actual: `eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_22_CS: CsTestCase = {
  id: 'TC_E_22_CS',
  name: 'Stop transaction options - EnergyTransfer stopped - SuspendedEV',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the energy transfer stopped by the EV and TxStopPoint is EnergyTransfer.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains EnergyTransfer, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // EV suspends energy transfer
    await ctx.station.suspendEV(1);

    // Step 1: TransactionEvent Ended with SuspendedEV
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EnergyTransfer stopped by EV',
      status:
        trigReason === 'ChargingStateChanged' &&
        chState === 'EVConnected' &&
        stoppedReason === 'StoppedByEV' &&
        txMsg != null
          ? 'passed'
          : 'failed',
      expected:
        'triggerReason ChargingStateChanged, chargingState EVConnected, stoppedReason StoppedByEV, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_14_CS: CsTestCase = {
  id: 'TC_E_14_CS',
  name: 'Stop transaction options - EVDisconnected - Charging Station side',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV and EVSE are disconnected at the Charging Station side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains EVConnected, State is EVConnectedPostSession

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Disconnect EV and EVSE
    await ctx.station.unplug(1);

    // Step 1: TransactionEvent Ended with EVCommunicationLost
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with EVCommunicationLost',
      status:
        trigReason === 'EVCommunicationLost' && chState === 'Idle' && txMsg != null
          ? 'passed'
          : 'failed',
      expected: 'triggerReason EVCommunicationLost, chargingState Idle, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_20_CS: CsTestCase = {
  id: 'TC_E_20_CS',
  name: 'Stop transaction options - EVDisconnected - EV side (able to charge IEC 61851-1 EV)',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV and EVSE are disconnected at the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains EVConnected, StopTxOnEVSideDisconnect false, State is EnergyTransferSuspended

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Disconnect on EV side
    await ctx.station.unplug(1);

    // Step 1: TransactionEvent Ended with EVCommunicationLost
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EV side disconnect',
      status:
        trigReason === 'EVCommunicationLost' &&
        chState === 'Idle' &&
        stoppedReason === 'EVDisconnected' &&
        txMsg != null
          ? 'passed'
          : 'failed',
      expected:
        'triggerReason EVCommunicationLost, chargingState Idle, stoppedReason EVDisconnected, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_54_CS: CsTestCase = {
  id: 'TC_E_54_CS',
  name: 'Stop transaction options - EVDisconnected - EV side (not able to charge IEC 61851-1 EV)',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV and EVSE are disconnected at the EV side (not able to charge).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains EVConnected, StopTxOnEVSideDisconnect false, State is EnergyTransferSuspended

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Disconnect on EV side
    await ctx.station.unplug(1);

    // Step 1: TransactionEvent Ended
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended - EV side disconnect (not able to charge)',
      status:
        trigReason === 'EVCommunicationLost' &&
        chState === 'Idle' &&
        (stoppedReason === 'StoppedByEV' || stoppedReason === 'EVDisconnected') &&
        txMsg != null
          ? 'passed'
          : 'failed',
      expected:
        'triggerReason EVCommunicationLost, chargingState Idle, stoppedReason StoppedByEV/EVDisconnected, eventType Ended',
      actual: `triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_15_CS: CsTestCase = {
  id: 'TC_E_15_CS',
  name: 'Stop transaction options - StopAuthorized - Local',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV driver locally stops the transaction and TxStopPoint is Authorized.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains Authorized, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: Present IdToken to stop
    await ctx.station.stopCharging(1, 'Local');

    // Step 1: TransactionEvent Ended with StopAuthorized Local
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with StopAuthorized Local',
      status:
        trigReason === 'StopAuthorized' && stoppedReason === 'Local' && txMsg != null
          ? 'passed'
          : 'failed',
      expected: 'triggerReason StopAuthorized, stoppedReason Local, eventType Ended',
      actual: `triggerReason=${trigReason}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_21_CS: CsTestCase = {
  id: 'TC_E_21_CS',
  name: 'Stop transaction options - StopAuthorized - Remote',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when it receives a RequestStopTransactionRequest and TxStopPoint is Authorized.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains Authorized, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    const txId = await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Step 1: CSMS sends RequestStopTransaction
    const stopResp = await ctx.server.sendCommand('RequestStopTransaction', {
      transactionId: txId,
    });

    // Step 2: CS responds with Accepted
    const stopPayload = stopResp as Record<string, unknown> | null;
    const stopStatus = stopPayload?.['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'RequestStopTransactionResponse status Accepted',
      status: stopStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status=${stopStatus}`,
    });

    // Step 3: TransactionEvent Ended with RemoteStop
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 3,
      description: 'TransactionEvent Ended with RemoteStop',
      status:
        trigReason === 'RemoteStop' && stoppedReason === 'Remote' && txMsg != null
          ? 'passed'
          : 'failed',
      expected: 'triggerReason RemoteStop, stoppedReason Remote, eventType Ended',
      actual: `triggerReason=${trigReason}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_19_CS: CsTestCase = {
  id: 'TC_E_19_CS',
  name: 'Stop transaction options - ParkingBayUnoccupied',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station stops a transaction when the EV left the parking bay and TxStopPoint is ParkingBayOccupancy.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStopPoint contains ParkingBayOccupancy, State is EVDisconnected

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // EV departs the parking bay
    await ctx.station.departParkingBay(1);

    // Step 1: TransactionEvent Ended with EVDeparted
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const trigReason = txMsg?.['triggerReason'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with EVDeparted',
      status:
        trigReason === 'EVDeparted' && stoppedReason === 'EVDeparted' && txMsg != null
          ? 'passed'
          : 'failed',
      expected: 'triggerReason EVDeparted, stoppedReason EVDeparted, eventType Ended',
      actual: `triggerReason=${trigReason}, stoppedReason=${stoppedReason}, eventType=${txMsg ? 'Ended' : 'timeout'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
