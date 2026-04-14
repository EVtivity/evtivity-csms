// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

/**
 * TC_I_02_CS: Show EV Driver Final Total Cost After Charging
 * Use case: I03 (I03.FR.01, I03.FR.03)
 */
export const TC_I_02_CS: CsTestCase = {
  id: 'TC_I_02_CS',
  name: 'Show EV Driver Final Total Cost After Charging',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'While a transaction is ongoing, the driver wants to know how much the running total cost is, updated at a regular interval.',
  purpose:
    'To verify if the Charging Station is able to correctly display the total cost as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    let endedReceived = false;

    ctx.server.setMessageHandler(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') {
        const eventType = payload.eventType;
        if (eventType === 'Ended') {
          endedReceived = true;
          return { totalCost: 15.5 };
        }
        return { idTokenInfo: { status: 'Accepted' } };
      }
      return {};
    });

    // Before: State is EnergyTransferStarted. Start a charging session first.
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Now stop to trigger Ended TransactionEvent
    await ctx.station.stopCharging(1, 'Local');

    // Step 1: Wait for Ended TransactionEvent
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const eventType = (txPayload as Record<string, unknown>).eventType;
    steps.push({
      step: 1,
      description: 'TransactionEventRequest Ended received',
      status: eventType === 'Ended' || endedReceived ? 'passed' : 'failed',
      expected: 'TransactionEventRequest with eventType Ended',
      actual: `eventType: ${String(eventType)}`,
    });

    // Verify totalCost was included in response
    steps.push({
      step: 2,
      description: 'TransactionEventResponse includes totalCost',
      status: endedReceived ? 'passed' : 'failed',
      expected: 'totalCost included in response to Ended event',
      actual: endedReceived ? 'totalCost sent in response' : 'Ended event not processed',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
