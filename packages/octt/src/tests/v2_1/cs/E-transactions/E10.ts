// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState, waitForTriggerReason } from '../../../../cs-test-helpers.js';

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

export const TC_E_26_CS: CsTestCase = {
  id: 'TC_E_26_CS',
  name: 'Disconnect cable on EV-side - Suspend transaction',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station can behave in several different ways when the cable is disconnected at the EV side.',
  purpose:
    'To verify if the Charging Station suspends the transaction when the EV and EVSE are disconnected at the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: StopTxOnEVSideDisconnect false, State is EnergyTransferStarted

    // Configure StopTxOnEVSideDisconnect to false
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          attributeValue: 'false',
          component: { name: 'TxCtrlr' },
          variable: { name: 'StopTxOnEVSideDisconnect' },
        },
      ],
    });

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

    // Step 1: TransactionEvent Updated with EVCommunicationLost (skip MeterValuePeriodic events)
    const tx1 = await waitForTriggerReason(ctx.server, 'EVCommunicationLost', 10000);
    const evt1 = tx1?.['eventType'] as string | undefined;
    const info1 = tx1?.['transactionInfo'] as Record<string, unknown> | undefined;
    const ch1 = info1?.['chargingState'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - EVCommunicationLost, Idle',
      status: tx1 != null && ch1 === 'Idle' && evt1 === 'Updated' ? 'passed' : 'failed',
      expected: 'triggerReason EVCommunicationLost, chargingState Idle, eventType Updated',
      actual: `triggerReason=${tx1?.['triggerReason'] as string | undefined}, chargingState=${ch1}, eventType=${evt1}`,
    });

    // Step 3: StatusNotification Available (cable disconnected)
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

    // Manual Action: Reconnect EV
    await ctx.station.plugIn(1);

    // Step 5: TransactionEvent Updated with CablePluggedIn (skip MeterValuePeriodic events)
    const tx5 = await waitForTriggerReason(ctx.server, 'CablePluggedIn', 10000);
    const evt5 = tx5?.['eventType'] as string | undefined;
    const info5 = tx5?.['transactionInfo'] as Record<string, unknown> | undefined;
    const ch5 = info5?.['chargingState'] as string | undefined;

    steps.push({
      step: 5,
      description: 'TransactionEvent Updated - CablePluggedIn, EVConnected',
      status: tx5 != null && ch5 === 'EVConnected' && evt5 === 'Updated' ? 'passed' : 'failed',
      expected: 'triggerReason CablePluggedIn, chargingState EVConnected, eventType Updated',
      actual: `triggerReason=${tx5?.['triggerReason'] as string | undefined}, chargingState=${ch5}, eventType=${evt5}`,
    });

    // Step 7: TransactionEvent Updated with ChargingStateChanged Charging (skip MeterValuePeriodic)
    const tx7 = await waitForTriggerReason(ctx.server, 'ChargingStateChanged', 10000);
    const evt7 = tx7?.['eventType'] as string | undefined;
    const info7 = tx7?.['transactionInfo'] as Record<string, unknown> | undefined;
    const ch7 = info7?.['chargingState'] as string | undefined;

    steps.push({
      step: 7,
      description: 'TransactionEvent Updated - ChargingStateChanged, Charging',
      status: tx7 != null && ch7 === 'Charging' && evt7 === 'Updated' ? 'passed' : 'failed',
      expected: 'triggerReason ChargingStateChanged, chargingState Charging, eventType Updated',
      actual: `triggerReason=${tx7?.['triggerReason'] as string | undefined}, chargingState=${ch7}, eventType=${evt7}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_27_CS: CsTestCase = {
  id: 'TC_E_27_CS',
  name: 'Disconnect cable on EV-side - Suspend transaction - Fixed cable connection timeout',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station can behave in several different ways when the cable is disconnected at the EV side.',
  purpose:
    'To verify if the Charging Station suspends the transaction when the EV and EVSE are disconnected at the EV side and the connection timeout expires.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: StopTxOnEVSideDisconnect false, EVConnectionTimeOut configured

    // Configure StopTxOnEVSideDisconnect false and a short EVConnectionTimeOut
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          attributeValue: 'false',
          component: { name: 'TxCtrlr' },
          variable: { name: 'StopTxOnEVSideDisconnect' },
        },
        {
          attributeValue: '3',
          component: { name: 'TxCtrlr' },
          variable: { name: 'EVConnectionTimeOut' },
        },
      ],
    });

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

    // Step 1: TransactionEvent Updated with EVCommunicationLost (skip MeterValuePeriodic events)
    const tx1 = await waitForTriggerReason(ctx.server, 'EVCommunicationLost', 10000);
    const evt1 = tx1?.['eventType'] as string | undefined;
    const info1 = tx1?.['transactionInfo'] as Record<string, unknown> | undefined;
    const ch1 = info1?.['chargingState'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - EVCommunicationLost, Idle',
      status: tx1 != null && ch1 === 'Idle' && evt1 === 'Updated' ? 'passed' : 'failed',
      expected: 'triggerReason EVCommunicationLost, chargingState Idle, eventType Updated',
      actual: `triggerReason=${tx1?.['triggerReason'] as string | undefined}, chargingState=${ch1}, eventType=${evt1}`,
    });

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

    // Step 5: TransactionEvent with EVConnectTimeout (wait for timeout, skip MeterValuePeriodic)
    const tx5 = await waitForTriggerReason(ctx.server, 'EVConnectTimeout', 30000);
    const evt5 = tx5?.['eventType'] as string | undefined;
    const info5 = tx5?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stopped5 = info5?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 5,
      description: 'TransactionEvent with EVConnectTimeout',
      status: tx5 != null ? 'passed' : 'failed',
      expected:
        'triggerReason EVConnectTimeout, eventType Ended (if TxStopPoint Authorized) or Updated',
      actual:
        tx5 != null
          ? `triggerReason=EVConnectTimeout, eventType=${evt5}, stoppedReason=${stopped5}`
          : 'No EVConnectTimeout TransactionEvent received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
