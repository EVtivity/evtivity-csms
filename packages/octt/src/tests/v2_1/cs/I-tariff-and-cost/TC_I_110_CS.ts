// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

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
    if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

/**
 * TC_I_110_CS: Clear Tariffs - DefaultTariff
 * Use case: I10 (I10.FR.02, I10.FR.03, I10.FR.06)
 */
export const TC_I_110_CS: CsTestCase = {
  id: 'TC_I_110_CS',
  name: 'Clear Tariffs - DefaultTariff',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To clear previously set tariffs on the charging station.',
  purpose: 'To verify if the Charging Station correctly clearing tariffs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const futureDate1 = new Date(Date.now() + 3600_000).toISOString();
    const futureDate2 = new Date(Date.now() + 7200_000).toISOString();
    const futureDate3 = new Date(Date.now() + 10800_000).toISOString();

    // Steps 1-8: Set four default tariffs
    const tariffs = [
      { tariffId: 'TestSystem1A', priceKwh: 0.1 },
      { tariffId: 'TestSystem1B', priceKwh: 0.2, validFrom: futureDate1 },
      { tariffId: 'TestSystem1C', priceKwh: 0.3, validFrom: futureDate2 },
      { tariffId: 'TestSystem1D', priceKwh: 0.4, validFrom: futureDate3 },
    ];

    for (let i = 0; i < tariffs.length; i++) {
      const t = tariffs[i] as (typeof tariffs)[number];
      const tariffPayload: Record<string, unknown> = {
        tariffId: t.tariffId,
        currency: 'EUR',
        energy: { prices: [{ priceKwh: t.priceKwh }] },
      };
      if ('validFrom' in t) tariffPayload.validFrom = t.validFrom;
      const res = await ctx.server.sendCommand('SetDefaultTariff', {
        evseId: 0,
        tariff: tariffPayload,
      });
      steps.push({
        step: (i + 1) * 2,
        description: `SetDefaultTariffResponse for ${t.tariffId} status Accepted`,
        status: (res as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String((res as Record<string, unknown>).status)}`,
      });
    }

    // Step 9-10: ClearTariffs for TestSystem1B and TestSystem1A
    const clearRes1 = await ctx.server.sendCommand('ClearTariffs', {
      tariffIds: ['TestSystem1B', 'TestSystem1A'],
    });
    const results1 = (clearRes1 as Record<string, unknown>).clearTariffsResult as
      | Array<Record<string, unknown>>
      | undefined;
    const allAccepted1 =
      results1 != null && results1.length === 2 && results1.every((r) => r.status === 'Accepted');
    steps.push({
      step: 10,
      description: 'ClearTariffsResponse for TestSystem1B and TestSystem1A',
      status: allAccepted1 ? 'passed' : 'failed',
      expected: 'Both clearTariffsResult status Accepted',
      actual: `results: ${JSON.stringify(results1)}`,
    });

    // Step 11-12: ClearTariffs with omitted tariffIds (clear all remaining)
    const clearRes2 = await ctx.server.sendCommand('ClearTariffs', {});
    const results2 = (clearRes2 as Record<string, unknown>).clearTariffsResult as
      | Array<Record<string, unknown>>
      | undefined;
    const allAccepted2 =
      results2 != null && results2.length === 2 && results2.every((r) => r.status === 'Accepted');
    steps.push({
      step: 12,
      description: 'ClearTariffsResponse for remaining tariffs (TestSystem1C, TestSystem1D)',
      status: allAccepted2 ? 'passed' : 'failed',
      expected: 'Both clearTariffsResult status Accepted for TestSystem1C and TestSystem1D',
      actual: `results: ${JSON.stringify(results2)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_111_CS: Clear Tariffs - Tariff in use
 * Use case: I10, I07 (I10.FR.01, I10.FR.07, I07.FR.10)
 */
export const TC_I_111_CS: CsTestCase = {
  id: 'TC_I_111_CS',
  name: 'Clear Tariffs - Tariff in use',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To clear previously set tariffs on the charging station while a tariff is in use.',
  purpose: 'To verify if the Charging Station correctly clearing tariffs that are in use.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: SetDefaultTariff
    const setRes = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: { tariffId: 'TestSystem1', currency: 'EUR', energy: { prices: [{ priceKwh: 2.0 }] } },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse status Accepted',
      status: (setRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((setRes as Record<string, unknown>).status)}`,
    });

    // Step 3: Execute Reusable State EnergyTransferStarted (tariff now in use)
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 4-5: ClearTariffs while tariff in use
    const clearRes = await ctx.server.sendCommand('ClearTariffs', {});
    const results = (clearRes as Record<string, unknown>).clearTariffsResult as
      | Array<Record<string, unknown>>
      | undefined;
    const hasAccepted =
      results != null &&
      results.some((r) => r.tariffId === 'TestSystem1' && r.status === 'Accepted');
    steps.push({
      step: 5,
      description: 'ClearTariffsResponse with TestSystem1 Accepted',
      status: hasAccepted ? 'passed' : 'failed',
      expected: 'clearTariffsResult[0].tariffId TestSystem1, status Accepted',
      actual: `results: ${JSON.stringify(results)}`,
    });

    // Step 6-7: GetTariffs should still show tariff as DefaultTariff (in use)
    const getRes = await ctx.server.sendCommand('GetTariffs', { evseId: 0 });
    const assignments = (getRes as Record<string, unknown>).tariffAssignments as
      | Array<Record<string, unknown>>
      | undefined;
    const hasDefaultTariff =
      assignments != null &&
      assignments.some((a) => a.tariffId === 'TestSystem1' && a.tariffKind === 'DefaultTariff');
    steps.push({
      step: 7,
      description: 'GetTariffsResponse shows tariff still as DefaultTariff (in use)',
      status:
        (getRes as Record<string, unknown>).status === 'Accepted' && hasDefaultTariff
          ? 'passed'
          : 'failed',
      expected: 'status Accepted, tariffKind DefaultTariff, tariffId TestSystem1',
      actual: `status: ${String((getRes as Record<string, unknown>).status)}, hasDefaultTariff: ${String(hasDefaultTariff)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
