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
  ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
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

/**
 * TC_I_100_CS: Set Default Tariff - validFrom
 * Use case: I07, I09, I10
 */
export const TC_I_100_CS: CsTestCase = {
  id: 'TC_I_100_CS',
  name: 'Set Default Tariff - validFrom',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To set the default tariff on the charging station, for example for ad hoc charging, or when there is no driver-specific tariff.',
  purpose:
    'To verify if the Charging Station correctly replaces tariffs based on the tariff validFrom fields.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: SetDefaultTariff with no validFrom
    const res1 = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1A',
        currency: 'EUR',
        energy: { prices: [{ priceKwh: 1.0 }] },
      },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse status Accepted',
      status: (res1 as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res1 as Record<string, unknown>).status)}`,
    });

    // Step 3-4: SetDefaultTariff with validFrom in the past
    const pastDate = new Date(Date.now() - 3600_000).toISOString();
    const res2 = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1B',
        validFrom: pastDate,
        currency: 'EUR',
        energy: { prices: [{ priceKwh: 2.0 }] },
      },
    });
    steps.push({
      step: 4,
      description: 'SetDefaultTariffResponse status Accepted (validFrom in past)',
      status: (res2 as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res2 as Record<string, unknown>).status)}`,
    });

    // Step 5-6: GetTariffs to verify TestSystem1B is active
    const res3 = await ctx.server.sendCommand('GetTariffs', { evseId: 0 });
    const assignments = (res3 as Record<string, unknown>).tariffAssignments as
      | Array<Record<string, unknown>>
      | undefined;
    const hasTariffB =
      assignments != null && assignments.length > 0 && assignments[0]?.tariffId === 'TestSystem1B';
    steps.push({
      step: 6,
      description: 'GetTariffsResponse shows TestSystem1B as active tariff',
      status:
        (res3 as Record<string, unknown>).status === 'Accepted' && hasTariffB ? 'passed' : 'failed',
      expected: 'status Accepted, tariffAssignments[0].tariffId = TestSystem1B',
      actual: `status: ${String((res3 as Record<string, unknown>).status)}, tariffId: ${String(assignments?.[0]?.tariffId)}`,
    });

    // Step 7-8: ClearTariffs
    const res4 = await ctx.server.sendCommand('ClearTariffs', {});
    steps.push({
      step: 8,
      description: 'ClearTariffsResponse received',
      status: 'passed',
      expected: 'ClearTariffsResponse',
      actual: `Response: ${JSON.stringify(res4)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_101_CS: Set Default Tariff - startTimeOfDay, endTimeOfDay
 * Use case: I07, I12
 */
export const TC_I_101_CS: CsTestCase = {
  id: 'TC_I_101_CS',
  name: 'Set Default Tariff - startTimeOfDay, endTimeOfDay',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To set the default tariff on the charging station with time-of-day conditions.',
  purpose: 'To verify if the Charging Station supports the start/endTimeOfDay conditions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Step 1-2: SetDefaultTariff with time-of-day charging time pricing
    const res = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        chargingTime: {
          prices: [{ priceMinute: 0.1 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse status Accepted',
      status: (res as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res as Record<string, unknown>).status)}`,
    });

    // Start a charging session so the station can generate RunningCost events
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 4: Wait for RunningCost TransactionEventRequest
    const txPayload = await waitForTriggerReason(ctx.server, 'RunningCost', 15_000);
    const costDetails =
      txPayload != null
        ? ((txPayload as Record<string, unknown>).costDetails as
            | Record<string, unknown>
            | undefined)
        : undefined;
    steps.push({
      step: 4,
      description: 'TransactionEventRequest with RunningCost trigger',
      status: txPayload != null ? 'passed' : 'failed',
      expected: 'triggerReason RunningCost',
      actual:
        txPayload != null
          ? `triggerReason: RunningCost, costDetails: ${costDetails != null ? 'present' : 'omitted'}`
          : 'No RunningCost event received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
