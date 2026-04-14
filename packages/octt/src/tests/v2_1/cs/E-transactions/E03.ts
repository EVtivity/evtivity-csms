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

export const TC_E_04_CS: CsTestCase = {
  id: 'TC_E_04_CS',
  name: 'Local start transaction - Authorization first - Success',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the Charging Station is able to start a charging session when the EV driver first presents a form of identification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: AuthCtrlr enabled, State is ParkingBayOccupied (optional)

    // Step 1: Execute Reusable State Authorized (local) - present idToken
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    const authMsg = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 1,
      description: 'Authorized (local) - Authorize received',
      status: authMsg ? 'passed' : 'failed',
      expected: 'Authorize received',
      actual: authMsg ? 'Received' : 'Timeout',
    });

    // Step 2: Execute Reusable State EnergyTransferStarted - plug in and start
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Find TransactionEvent with chargingState Charging (skip other messages)
    let chState: string | undefined;
    for (let _i = 0; _i < 10; _i++) {
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const txInfo = (msg as Record<string, unknown>)['transactionInfo'] as
          | Record<string, unknown>
          | undefined;
        chState = txInfo?.['chargingState'] as string | undefined;
        if (chState === 'Charging') break;
      } catch {
        break;
      }
    }
    steps.push({
      step: 2,
      description: 'EnergyTransferStarted - TransactionEvent with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'TransactionEvent with chargingState Charging',
      actual: `chargingState=${String(chState)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_05_CS: CsTestCase = {
  id: 'TC_E_05_CS',
  name: 'Local start transaction - Authorization first - Cable plugin timeout',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the Charging Station is able to deauthorize the transaction after the EVConnectionTimeout has expired.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: EVConnectionTimeOut configured, State is Authorized (local)
    ctx.station.setConfigValue('TxCtrlr.EVConnectionTimeOut', '3');
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    // Drain Authorize message
    try {
      await ctx.server.waitForMessage('Authorize', 2000);
    } catch {
      /* drain */
    }
    // Do NOT plug in - wait for timeout

    // Step 1: TransactionEvent with EVConnectTimeout trigger.
    // Skip any Started/Updated events that arrive before the timeout fires.
    let txPayload: Record<string, unknown> | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        if (msg['triggerReason'] === 'EVConnectTimeout') {
          txPayload = msg;
          break;
        }
      } catch {
        break;
      }
    }
    const trigReason = txPayload?.['triggerReason'] as string | undefined;
    const evtType = txPayload?.['eventType'] as string | undefined;
    const txInfo = txPayload?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    const triggerValid = trigReason === 'EVConnectTimeout';
    const eventValid = evtType === 'Ended' || evtType === 'Updated';

    steps.push({
      step: 1,
      description: 'TransactionEvent with EVConnectTimeout',
      status: triggerValid && eventValid ? 'passed' : 'failed',
      expected:
        'triggerReason EVConnectTimeout, eventType Ended (if TxStopPoint Authorized) or Updated',
      actual: `triggerReason=${trigReason}, eventType=${evtType}, stoppedReason=${stoppedReason}`,
    });

    // Step 3: Verify EVSE ready for new session - authorize again
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    const authMsg = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 3,
      description: 'Authorized (local) - verify EVSE ready for new session',
      status: authMsg ? 'passed' : 'failed',
      expected: 'Authorize received (EVSE ready for new session)',
      actual: authMsg ? 'Received' : 'Timeout',
    });

    // Step 4: Execute Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
    } catch {
      /* may already be consumed */
    }

    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const txStartPayload = txStartMsg as Record<string, unknown> | null;
    const startInfo = txStartPayload?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = startInfo?.['chargingState'] as string | undefined;
    steps.push({
      step: 4,
      description: 'EnergyTransferStarted - TransactionEvent with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'TransactionEvent with chargingState Charging',
      actual: `chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_38_CS: CsTestCase = {
  id: 'TC_E_38_CS',
  name: 'Local start transaction - EV not ready',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the Charging Station is able to handle and report if an EV is not ready to start the energy transfer.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: State is Authorized, EV set to not ready state

    // Setup: authorize, plug in, start charging
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover messages
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Manual Action: EV stops accepting energy (not ready)
    await ctx.station.setEvNotReady(1);

    // Step 2: TransactionEvent with SuspendedEV (EV not ready)
    const txMsg = await waitForTriggerReason(ctx.server, 'ChargingStateChanged', 10_000);
    const txPayload = txMsg as Record<string, unknown> | null;
    const trigReason = txPayload?.['triggerReason'] as string | undefined;
    const txInfo = txPayload?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;

    steps.push({
      step: 2,
      description: 'TransactionEvent with chargingState SuspendedEV',
      status:
        trigReason === 'ChargingStateChanged' && chState === 'SuspendedEV' ? 'passed' : 'failed',
      expected: 'triggerReason ChargingStateChanged, chargingState SuspendedEV',
      actual: `triggerReason=${trigReason}, chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_52_CS: CsTestCase = {
  id: 'TC_E_52_CS',
  name: 'Local start transaction - Authorization first - DisableRemoteAuthorization',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When DisableRemoteAuthorization is set to true, the Charging Station will only try to look up an IdToken in the local cache or list.',
  purpose:
    'To verify that the Charging Station will not send an AuthorizeRequest when DisableRemoteAuthorization is true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: AuthCtrlr.DisableRemoteAuthorization true, no valid tokens in cache/list
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          attributeValue: 'true',
          component: { name: 'AuthCtrlr' },
          variable: { name: 'DisableRemoteAuthorization' },
        },
      ],
    });

    // Present an unknown idToken
    await ctx.station.authorize(1, 'UNKNOWN-TOKEN-999');

    // Step 1: CS does NOT send AuthorizeRequest (5s negative check)
    let authReceived = false;
    try {
      const authMsg = await ctx.server.waitForMessage('Authorize', 5000);
      if (authMsg) authReceived = true;
    } catch {
      authReceived = false;
    }
    steps.push({
      step: 1,
      description: 'Charging Station does NOT send AuthorizeRequest',
      status: !authReceived ? 'passed' : 'failed',
      expected: 'No AuthorizeRequest sent',
      actual: authReceived
        ? 'AuthorizeRequest received (unexpected)'
        : 'No AuthorizeRequest (correct)',
    });

    // Step 2: Execute Reusable State EVConnectedPreSession - plug in
    await ctx.station.plugIn(1);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 2,
      description: 'EVConnectedPreSession - StatusNotification received',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 3: CS does NOT start charging (5s negative check)
    let chargingStarted = false;
    try {
      const txMsg = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const txPayload = txMsg as Record<string, unknown> | null;
      const txInfo = txPayload?.['transactionInfo'] as Record<string, unknown> | undefined;
      const chState = txInfo?.['chargingState'] as string | undefined;
      if (chState === 'Charging') chargingStarted = true;
    } catch {
      chargingStarted = false;
    }
    steps.push({
      step: 3,
      description: 'Charging Station does NOT start charging',
      status: !chargingStarted ? 'passed' : 'failed',
      expected: 'No Charging state',
      actual: chargingStarted ? 'Charging started (unexpected)' : 'No charging (correct)',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
