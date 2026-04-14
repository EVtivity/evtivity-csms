// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

export const TC_E_06_CS: CsTestCase = {
  id: 'TC_E_06_CS',
  name: 'Local Stop Transaction - Accepted',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The EV Driver is able to stop an ongoing transaction, by locally presenting an IdToken.',
  purpose: 'To verify whether the Charging Station is able to perform a local stop authorization.',
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

    // Before: AuthCtrlr enabled, State is EnergyTransferStarted

    // Setup: Start a charging session to reach EnergyTransferStarted state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: Execute Reusable State StopAuthorized (local) - present idToken to stop
    await ctx.station.stopCharging(1, 'Local');
    // Find TransactionEvent Ended (skip MeterValuePeriodic Updated events)
    let trigReason: string | undefined;
    for (let _i = 0; _i < 10; _i++) {
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const evtType = (msg as Record<string, unknown>)['eventType'] as string | undefined;
        if (evtType === 'Ended') {
          trigReason = (msg as Record<string, unknown>)['triggerReason'] as string | undefined;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 1,
      description: 'StopAuthorized (local) - triggerReason StopAuthorized',
      status: trigReason === 'StopAuthorized' ? 'passed' : 'failed',
      expected: 'triggerReason StopAuthorized',
      actual: `triggerReason=${String(trigReason)}`,
    });

    // Step 2: Execute Reusable State EVConnectedPostSession
    // Drain any leftover StatusNotifications from stop
    for (let _d = 0; _d < 3; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    // Step 3: Execute Reusable State EVDisconnected - unplug
    await ctx.station.unplug(1);
    const statusMsg3 = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 3,
      description: 'EVDisconnected - StatusNotification received',
      status: statusMsg3 ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg3 ? 'Received' : 'Timeout',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
