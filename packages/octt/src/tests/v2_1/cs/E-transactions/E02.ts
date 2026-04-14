// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_E_03_CS: CsTestCase = {
  id: 'TC_E_03_CS',
  name: 'Local start transaction - Cable plugin first - Success',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the Charging Station is able to start a charging session when the EV driver first connects the EV and EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

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

    // Before: AuthCtrlr enabled, State is EVConnectedPreSession (cable already plugged)

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

    // Step 2: Execute Reusable State EnergyTransferStarted
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
