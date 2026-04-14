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

export const TC_E_24_CS: CsTestCase = {
  id: 'TC_E_24_CS',
  name: 'Disconnect cable on EV-side - Deauthorize transaction - UnlockOnEVSideDisconnect is true',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station can behave in several different ways when the cable is disconnected at the EV side.',
  purpose:
    'To verify if the Charging Station deauthorizes the transaction when the EV and EVSE are disconnected at the EV side with UnlockOnEVSideDisconnect true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: StopTxOnEVSideDisconnect true, UnlockOnEVSideDisconnect true, State is EnergyTransferSuspended

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

    // Step 1: TransactionEvent with EVCommunicationLost (skip MeterValuePeriodic events)
    const txMsg = await waitForTriggerReason(ctx.server, 'EVCommunicationLost', 10000);
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent with EVCommunicationLost, chargingState Idle',
      status: txMsg != null && chState === 'Idle' ? 'passed' : 'failed',
      expected: 'triggerReason EVCommunicationLost, chargingState Idle',
      actual: `triggerReason=${txMsg?.['triggerReason'] as string | undefined}, chargingState=${chState}`,
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

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_25_CS: CsTestCase = {
  id: 'TC_E_25_CS',
  name: 'Disconnect cable on EV-side - Deauthorize transaction - UnlockOnEVSideDisconnect is false',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station can behave in several different ways when the cable is disconnected at the EV side.',
  purpose:
    'To verify if the Charging Station deauthorizes the transaction when the EV and EVSE are disconnected at the EV side with UnlockOnEVSideDisconnect false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: StopTxOnEVSideDisconnect true, UnlockOnEVSideDisconnect false, State is EnergyTransferSuspended

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

    // Step 1: TransactionEvent with EVCommunicationLost (skip MeterValuePeriodic events)
    const txMsg = await waitForTriggerReason(ctx.server, 'EVCommunicationLost', 10000);
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;

    steps.push({
      step: 1,
      description: 'TransactionEvent with EVCommunicationLost, chargingState Idle',
      status: txMsg != null && chState === 'Idle' ? 'passed' : 'failed',
      expected: 'triggerReason EVCommunicationLost, chargingState Idle',
      actual: `triggerReason=${txMsg?.['triggerReason'] as string | undefined}, chargingState=${chState}`,
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

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
