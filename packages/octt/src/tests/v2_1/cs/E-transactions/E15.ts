// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState, waitForTransactionEventType } from '../../../../cs-test-helpers.js';

export const TC_E_46_CS: CsTestCase = {
  id: 'TC_E_46_CS',
  name: 'End of charging process 15118',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'After receiving a SessionStopReq(Terminate) message from the EV, the Charging Station informs the CSMS.',
  purpose:
    'To verify whether the Charging Station is able to inform the CSMS that authorization of the charging session should be ended via ISO 15118.',
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

    // Before: State is EVConnectedPreSession, Authorized15118, EnergyTransferStarted
    // Setup: start a charging session
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // EV sends SessionStopReq(Terminate) - stop charging
    await ctx.station.stopCharging(1, 'Local');

    // Step 1: TransactionEvent with StopAuthorized (skip MeterValuePeriodic events)
    const txMsg = await waitForTransactionEventType(ctx.server, 'Ended', 10_000);
    const txPayload = txMsg as Record<string, unknown> | null;
    const evtType = txPayload?.['eventType'] as string | undefined;
    const trigReason = txPayload?.['triggerReason'] as string | undefined;
    const txInfo = txPayload?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;
    const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;

    const eventValid = evtType === 'Ended' || evtType === 'Updated';
    const trigValid = trigReason === 'StopAuthorized';
    const stateValid = chState === 'EVConnected';

    steps.push({
      step: 1,
      description: 'TransactionEvent with StopAuthorized, chargingState EVConnected',
      status: eventValid && trigValid && stateValid ? 'passed' : 'failed',
      expected: 'eventType Ended/Updated, triggerReason StopAuthorized, chargingState EVConnected',
      actual: `eventType=${evtType}, triggerReason=${trigReason}, chargingState=${chState}, stoppedReason=${stoppedReason}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
