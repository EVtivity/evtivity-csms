// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { defaultReply } from '../../../../default-replies.js';
import { buildOcppTariff } from '@evtivity/lib';
import type { OcppTariff, OcppTariffSource } from '@evtivity/lib';

/** A pricing group of TC_I_101: 0.25/kWh from 08:00 to 20:00, 0.20/kWh otherwise. */
function groupDerivedDayTariff(): OcppTariff {
  const tariff = (overrides: Partial<OcppTariffSource>): OcppTariffSource => ({
    id: 'octt-101-default',
    pricePerKwh: '0.20',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions: null,
    priority: 0,
    isDefault: true,
    ...overrides,
  });
  const fallback = tariff({});
  const day = tariff({
    id: 'octt-101-day',
    pricePerKwh: '0.25',
    restrictions: { timeRange: { startTime: '08:00', endTime: '20:00' } },
    priority: 10,
    isDefault: false,
  });
  return buildOcppTariff({
    current: fallback,
    groupTariffs: [fallback, day],
    graceMinutes: 0,
    holidays: [],
    at: new Date(),
    timezone: 'UTC',
    currency: 'USD',
    taxBasis: 'net',
    support: { conditions: true, maxElements: null },
  });
}

/**
 * TC_I_101_CSMS: Set Default Tariff - startTimeOfDay, endTimeOfDay
 * Use case: I07, I12
 * Scenario:
 *   Manual Action: Request the CSMS to set a default tariff on EVSE 0
 *   1. CSMS sends SetDefaultTariffRequest
 *   2. Test System responds with SetDefaultTariffResponse Accepted
 */
export const TC_I_101_CSMS: TestCase = {
  id: 'TC_I_101_CSMS',
  name: 'Set Default Tariff - startTimeOfDay, endTimeOfDay',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To set the default tariff on the charging station, for example for ad hoc charging, or when there is no driver-specific tariff.',
  purpose: 'To verify if the CSMS is able to set a tariff with conditions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetDefaultTariff = false;
    let tariffPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          receivedSetDefaultTariff = true;
          tariffPayload = payload;
          return { status: 'Accepted' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    // Wait for CSMS to send SetDefaultTariffRequest (manual action trigger)
    if (ctx.triggerCommand != null) {
      // The tariff is derived from a pricing group (a day window 08:00-20:00
      // and the default) by the builder the CSMS sends tariffs with
      // (AuthorizeResponse, ChangeTransactionTariff), so the window is the
      // CSMS's own startTimeOfDay/endTimeOfDay mapping. A default tariff may
      // carry validFrom (I07); a driver tariff never does (I08.FR.09).
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: { ...groupDerivedDayTariff(), validFrom: new Date().toISOString() },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const evseId = tariffPayload['evseId'];
    const tariff = tariffPayload['tariff'] as Record<string, unknown> | undefined;
    const validFrom = tariff?.['validFrom'];
    const energy = tariff?.['energy'] as Record<string, unknown> | undefined;
    const prices = energy?.['prices'] as Record<string, unknown>[] | undefined;

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest',
      status: receivedSetDefaultTariff ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest received with evseId 0',
      actual: receivedSetDefaultTariff
        ? `Received, evseId = ${String(evseId)}`
        : 'No SetDefaultTariffRequest received',
    });

    const evseIdValid = evseId === 0;
    steps.push({
      step: 2,
      description: 'evseId must be 0',
      status: evseIdValid ? 'passed' : 'failed',
      expected: 'evseId = 0',
      actual: `evseId = ${String(evseId)}`,
    });

    steps.push({
      step: 3,
      description: 'tariff.validFrom must not be omitted',
      status: validFrom != null ? 'passed' : 'failed',
      expected: 'validFrom present',
      actual: validFrom != null ? `validFrom = ${String(validFrom)}` : 'validFrom omitted',
    });

    const firstConditions = prices?.[0]?.['conditions'] as Record<string, unknown> | undefined;
    const hasConditions =
      firstConditions?.['startTimeOfDay'] === '08:00' &&
      firstConditions['endTimeOfDay'] === '20:00';
    steps.push({
      step: 4,
      description: 'tariff.energy.prices[0].conditions with startTimeOfDay and endTimeOfDay',
      status: hasConditions ? 'passed' : 'failed',
      expected: 'Conditions with startTimeOfDay and endTimeOfDay present',
      actual: hasConditions ? 'Conditions present' : 'Conditions missing',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_I_102_CSMS: Set Default Tariff - TariffMaxElements
 * Use case: I07, I11
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest
 *   2. Test System responds with SetDefaultTariffResponse TooManyElements
 */
export const TC_I_102_CSMS: TestCase = {
  id: 'TC_I_102_CSMS',
  name: 'Set Default Tariff - TariffMaxElements',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To set the default tariff on the charging station, for example for ad hoc charging, or when there is no driver-specific tariff.',
  purpose: 'To verify if the CSMS is able to process a response indicating TooManyElements.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetDefaultTariff = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          receivedSetDefaultTariff = true;
          return { status: 'TooManyElements' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: {
          tariffId: 'octt-tariff-102',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: { prices: [{ priceKwh: 0.25 }] },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest, respond TooManyElements',
      status: receivedSetDefaultTariff ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest received',
      actual: receivedSetDefaultTariff
        ? 'Received, responded with TooManyElements'
        : 'No SetDefaultTariffRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_I_105_CSMS: Set Default Tariff - TariffConditionsSupported is false
 * Use case: I07
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest
 *   2. Test System responds with SetDefaultTariffResponse ConditionNotSupported
 */
export const TC_I_105_CSMS: TestCase = {
  id: 'TC_I_105_CSMS',
  name: 'Set Default Tariff - TariffConditionsSupported is false',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To set the default tariff on the charging station, for example for ad hoc charging, or when there is no driver-specific tariff.',
  purpose: 'To verify if the CSMS is able to process a response indicating ConditionNotSupported.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetDefaultTariff = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          receivedSetDefaultTariff = true;
          return { status: 'ConditionNotSupported' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: {
          tariffId: 'octt-tariff-105',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [
              {
                priceKwh: 0.25,
                conditions: { startTimeOfDay: '08:00', endTimeOfDay: '20:00' },
              },
            ],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest, respond ConditionNotSupported',
      status: receivedSetDefaultTariff ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest received',
      actual: receivedSetDefaultTariff
        ? 'Received, responded with ConditionNotSupported'
        : 'No SetDefaultTariffRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_I_106_CSMS: Set Default Tariff - validations
 * Use case: I07, I09
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest for EVSE 0 (full tariff)
 *   2. Respond Accepted
 *   3. CSMS sends SetDefaultTariffRequest for EVSE 1 (different tariffId)
 *   4. Respond Accepted
 *   5. CSMS sends GetTariffsRequest
 *   6. Respond with tariff assignments
 */
export const TC_I_106_CSMS: TestCase = {
  id: 'TC_I_106_CSMS',
  name: 'Set Default Tariff - validations',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To set the default tariff on the charging station, for example for ad hoc charging, or when there is no driver-specific tariff.',
  purpose: 'To verify if the CSMS supports configuring setting local cost calculation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let setTariffCount = 0;
    let tariffId1 = '';
    let tariffId2 = '';
    let receivedGetTariffs = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          setTariffCount++;
          const tariff = payload['tariff'] as Record<string, unknown> | undefined;
          const tid = tariff?.['tariffId'] as string;
          if (setTariffCount === 1) tariffId1 = tid;
          if (setTariffCount === 2) tariffId2 = tid;
          return { status: 'Accepted' };
        }
        if (action === 'GetTariffs') {
          receivedGetTariffs = true;
          return {
            status: 'Accepted',
            tariffAssignments: [
              {
                tariffId: tariffId1,
                tariffKind: 'DefaultTariff',
                evseIds: [2],
                validFrom: new Date().toISOString(),
              },
              {
                tariffId: tariffId2,
                tariffKind: 'DefaultTariff',
                evseIds: [1],
                validFrom: new Date().toISOString(),
              },
            ],
          };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 0,
        tariff: {
          tariffId: 'octt-tariff-106a',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [{ priceKwh: 0.25 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          chargingTime: {
            prices: [{ priceMinute: 0.05 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          idleTime: {
            prices: [{ priceMinute: 0.1 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          fixedFee: {
            prices: [{ priceFixed: 1.0 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          minCost: {
            exclTax: 1.0,
            inclTax: 1.2,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          maxCost: {
            exclTax: 50.0,
            inclTax: 60.0,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          reservationTime: {
            prices: [{ priceMinute: 0.02 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
        },
      });
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 1,
        tariff: {
          tariffId: 'octt-tariff-106b',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [{ priceKwh: 0.3 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          chargingTime: {
            prices: [{ priceMinute: 0.06 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          idleTime: {
            prices: [{ priceMinute: 0.12 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          fixedFee: {
            prices: [{ priceFixed: 1.5 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          minCost: {
            exclTax: 2.0,
            inclTax: 2.4,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          maxCost: {
            exclTax: 60.0,
            inclTax: 72.0,
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
          reservationTime: {
            prices: [{ priceMinute: 0.03 }],
            taxRates: [{ tax: 20, type: 'VAT' }],
          },
        },
      });
      await ctx.triggerCommand('v21', 'GetTariffs', {
        stationId: ctx.stationId,
        evseId: 0,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest for EVSE 0',
      status: setTariffCount >= 1 ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest received',
      actual: setTariffCount >= 1 ? `Received, tariffId = ${tariffId1}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends SetDefaultTariffRequest for EVSE 1 with different tariffId',
      status: setTariffCount >= 2 && tariffId2 !== tariffId1 ? 'passed' : 'failed',
      expected: 'Second SetDefaultTariffRequest with different tariffId',
      actual:
        setTariffCount >= 2
          ? `tariffId1 = ${tariffId1}, tariffId2 = ${tariffId2}`
          : `Only ${String(setTariffCount)} received`,
    });

    steps.push({
      step: 3,
      description: 'CSMS sends GetTariffsRequest',
      status: receivedGetTariffs ? 'passed' : 'failed',
      expected: 'GetTariffsRequest received',
      actual: receivedGetTariffs ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
