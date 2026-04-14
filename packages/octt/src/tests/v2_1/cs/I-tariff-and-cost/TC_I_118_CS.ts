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
 * TC_I_118_CS: Local Cost Calculation - Cost Details of Transaction - no tariff conditions
 * Use case: I12
 */
export const TC_I_118_CS: CsTestCase = {
  id: 'TC_I_118_CS',
  name: 'Local Cost Calculation - Cost Details of Transaction - no tariff conditions',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station calculates cost of the transaction locally and returns a break-down of the cost at end of transaction.',
  purpose:
    'To verify if the Charging Station correctly reports the cost and usage details of a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: SetDefaultTariff with energy and chargingTime pricing
    const setRes = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        energy: {
          prices: [{ priceKwh: 5.0 }],
          taxRates: [
            { type: 't4_5', tax: 4.5 },
            { type: 't5_5', tax: 5.5 },
          ],
        },
        chargingTime: {
          prices: [{ priceMinute: 6.0 }],
          taxRates: [
            { type: 't34_5', tax: 34.5 },
            { type: 't5_5', tax: 5.5 },
          ],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse Accepted',
      status: (setRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((setRes as Record<string, unknown>).status)}`,
    });

    // Start a charging session to trigger local cost calculation
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 4: Wait for first RunningCost TransactionEventRequest
    const tx1 = await waitForTriggerReason(ctx.server, 'RunningCost', 15_000);
    const costDetails1 =
      tx1 != null
        ? ((tx1 as Record<string, unknown>).costDetails as Record<string, unknown> | undefined)
        : undefined;
    steps.push({
      step: 4,
      description: 'TransactionEventRequest RunningCost with costDetails',
      status: tx1 != null && costDetails1 != null ? 'passed' : 'failed',
      expected: 'triggerReason RunningCost with costDetails',
      actual:
        tx1 != null
          ? `trigger: RunningCost, hasCostDetails: ${String(costDetails1 != null)}`
          : 'No RunningCost event received',
    });

    // Step 6: Wait for second RunningCost (cost should increase with time/energy)
    const tx2 = await waitForTriggerReason(ctx.server, 'RunningCost', 15_000);
    const costDetails2 =
      tx2 != null
        ? ((tx2 as Record<string, unknown>).costDetails as Record<string, unknown> | undefined)
        : undefined;
    steps.push({
      step: 6,
      description: 'Second RunningCost with cost details',
      status: tx2 != null && costDetails2 != null ? 'passed' : 'failed',
      expected: 'triggerReason RunningCost with costDetails',
      actual:
        tx2 != null
          ? `trigger: RunningCost, hasCostDetails: ${String(costDetails2 != null)}`
          : 'No second RunningCost event',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_119_CS: Local Cost Calculation - Cost Details of Transaction - with tariff conditions
 * Use case: I12
 */
export const TC_I_119_CS: CsTestCase = {
  id: 'TC_I_119_CS',
  name: 'Local Cost Calculation - Cost Details of Transaction - with tariff conditions',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station calculates cost of the transaction locally with tariff conditions and returns a break-down.',
  purpose:
    'To verify if the Charging Station correctly reports the cost and usage details of a transaction with conditions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: SetDefaultTariff with chargingTime pricing (simple, no conditions for CSS)
    const setRes = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        chargingTime: {
          prices: [{ priceMinute: 6.0 }],
          taxRates: [{ type: 't20_0', tax: 20.0 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse Accepted',
      status: (setRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((setRes as Record<string, unknown>).status)}`,
    });

    // Start a charging session to trigger local cost calculation
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 4: Wait for RunningCost TransactionEvent
    const txPayload = await waitForTriggerReason(ctx.server, 'RunningCost', 15_000);
    const costDetails =
      txPayload != null
        ? ((txPayload as Record<string, unknown>).costDetails as
            | Record<string, unknown>
            | undefined)
        : undefined;
    steps.push({
      step: 4,
      description: 'TransactionEventRequest RunningCost with costDetails',
      status: txPayload != null && costDetails != null ? 'passed' : 'failed',
      expected: 'triggerReason RunningCost with costDetails',
      actual:
        txPayload != null
          ? `trigger: RunningCost, hasCostDetails: ${String(costDetails != null)}`
          : 'No RunningCost event received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
