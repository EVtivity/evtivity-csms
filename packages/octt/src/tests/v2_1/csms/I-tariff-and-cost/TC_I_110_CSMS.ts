// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_I_110_CSMS: Clear Tariffs - DefaultTariff
 * Use case: I10
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest
 *   2. Respond Accepted
 *   3. CSMS sends ClearTariffsRequest with the tariffId from step 1
 *   4. Respond Accepted
 *   5. CSMS sends ClearTariffsRequest (clear all)
 *   6. Respond NoTariff
 */
export const TC_I_110_CSMS: TestCase = {
  id: 'TC_I_110_CSMS',
  name: 'Clear Tariffs - DefaultTariff',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To clear previously set tariffs on the charging station.',
  purpose: 'To verify if the CSMS is able to clear tariffs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let setTariffId = '';
    let clearTariffCount = 0;
    let clearTariffIds: unknown[] = [];

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          const tariff = payload['tariff'] as Record<string, unknown> | undefined;
          setTariffId = String(tariff?.['tariffId'] ?? '');
          return { status: 'Accepted' };
        }
        if (action === 'ClearTariffs') {
          clearTariffCount++;
          const tariffIds = payload['tariffIds'] as unknown[] | undefined;
          clearTariffIds = tariffIds ?? [];

          if (clearTariffCount === 1) {
            return {
              clearTariffsResult: [{ tariffId: setTariffId, status: 'Accepted' }],
            };
          }
          // Second clear (all tariffs) - no tariffs left
          return {
            clearTariffsResult: [{ status: 'NoTariff' }],
          };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: {
          tariffId: 'octt-tariff-110',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: { prices: [{ priceKwh: 0.25 }] },
        },
      });
      await ctx.triggerCommand('v21', 'ClearTariffs', {
        stationId: ctx.stationId,
        tariffIds: ['octt-tariff-110'],
      });
      await ctx.triggerCommand('v21', 'ClearTariffs', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest',
      status: setTariffId !== '' ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest with tariffId',
      actual: setTariffId !== '' ? `tariffId = ${setTariffId}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends ClearTariffsRequest with specific tariffId',
      status: clearTariffCount >= 1 ? 'passed' : 'failed',
      expected: 'ClearTariffsRequest with tariffIds[0] matching step 1',
      actual:
        clearTariffCount >= 1
          ? `Received, tariffIds = ${JSON.stringify(clearTariffIds)}`
          : 'Not received',
    });

    steps.push({
      step: 3,
      description: 'CSMS sends ClearTariffsRequest to clear all',
      status: clearTariffCount >= 2 ? 'passed' : 'failed',
      expected: 'ClearTariffsRequest with tariffIds omitted',
      actual: clearTariffCount >= 2 ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
