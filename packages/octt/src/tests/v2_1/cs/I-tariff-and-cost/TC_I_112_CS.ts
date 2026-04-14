// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

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
 * TC_I_112_CS: Local Cost Calculation - Change transaction tariff - local cost calculation unsupported
 * Use case: I11 (I11.FR.01)
 */
export const TC_I_112_CS: CsTestCase = {
  id: 'TC_I_112_CS',
  name: 'Local Cost Calculation - Change transaction tariff - local cost calculation unsupported',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose:
    'To verify if the Charging Station correctly validates the tariff change when unsupported.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Configure station to NOT support local cost calculation
    ctx.station.setConfigValue('TariffCostCtrlr.LocalCostSupported', 'false');

    // Step 1-2: Send ChangeTransactionTariff - expect CALLERROR NotSupported/NotImplemented
    try {
      await ctx.server.sendCommand('ChangeTransactionTariff', {
        transactionId: '0',
        tariff: {
          tariffId: 'TestSystem1',
          currency: 'EUR',
          energy: { prices: [{ priceKwh: 1.0 }] },
        },
      });
      steps.push({
        step: 2,
        description: 'CALLERROR expected',
        status: 'failed',
        expected: 'CALLERROR NotSupported or NotImplemented',
        actual: 'Received CALLRESULT instead of CALLERROR',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isExpected = msg.includes('NotSupported') || msg.includes('NotImplemented');
      steps.push({
        step: 2,
        description: 'CALLERROR NotSupported or NotImplemented',
        status: isExpected ? 'passed' : 'failed',
        expected: 'CALLERROR NotSupported or NotImplemented',
        actual: msg,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_113_CS: Local Cost Calculation - Change transaction tariff - TariffMaxElements
 * Use case: I11 (I11.FR.02)
 */
export const TC_I_113_CS: CsTestCase = {
  id: 'TC_I_113_CS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffMaxElements',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose:
    'To verify if the Charging Station correctly validates the tariff change for TariffMaxElements.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: GetVariables for TariffMaxElements
    const getVarRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'TariffCostCtrlr' },
          variable: { name: 'MaxElements', instance: 'Tariff' },
        },
      ],
    });
    const results = (getVarRes as Record<string, unknown>).getVariableResult as
      | Array<Record<string, unknown>>
      | undefined;
    steps.push({
      step: 2,
      description: 'GetVariablesResponse with TariffMaxElements',
      status: results != null && results.length > 0 ? 'passed' : 'failed',
      expected: 'getVariableResult with TariffCostCtrlr MaxElements',
      actual: `results: ${JSON.stringify(results)}`,
    });

    // Step 3-4: ChangeTransactionTariff with too many elements - expect TooManyElements
    const tooManyRes = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        energy: { prices: Array.from({ length: 100 }, (_, i) => ({ priceKwh: 1.0 + i })) },
      },
    });
    steps.push({
      step: 4,
      description: 'ChangeTransactionTariffResponse TooManyElements',
      status:
        (tooManyRes as Record<string, unknown>).status === 'TooManyElements' ? 'passed' : 'failed',
      expected: 'status TooManyElements',
      actual: `status: ${String((tooManyRes as Record<string, unknown>).status)}`,
    });

    // Step 5-6: ChangeTransactionTariff within limits - expect Accepted
    const okRes = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: { tariffId: 'TestSystem1', currency: 'EUR', energy: { prices: [{ priceKwh: 1.0 }] } },
    });
    steps.push({
      step: 6,
      description: 'ChangeTransactionTariffResponse Accepted',
      status: (okRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((okRes as Record<string, unknown>).status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_114_CS: Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is false
 * Use case: I11 (I11.FR.03)
 */
export const TC_I_114_CS: CsTestCase = {
  id: 'TC_I_114_CS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is false',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose:
    'To verify if the Charging Station correctly validates the tariff change when conditions not supported.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const res = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem99',
        currency: 'EUR',
        energy: {
          prices: [
            {
              priceKwh: 1.0,
              conditions: {
                startTimeOfDay: '00:00',
                endTimeOfDay: '00:00',
                validFromDate: '2012-01-01',
                validToDate: '2027-12-31',
                minEnergy: 10,
                maxEnergy: 10000,
                dayOfWeek: [
                  'Monday',
                  'Tuesday',
                  'Wednesday',
                  'Thursday',
                  'Friday',
                  'Saturday',
                  'Sunday',
                ],
                evseKind: 'AC',
              },
            },
          ],
        },
        fixedFee: {
          prices: [{ conditions: { paymentBrand: 'PayMe', paymentRecognition: 'Debit' } }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'ChangeTransactionTariffResponse ConditionNotSupported',
      status:
        (res as Record<string, unknown>).status === 'ConditionNotSupported' ? 'passed' : 'failed',
      expected: 'status ConditionNotSupported',
      actual: `status: ${String((res as Record<string, unknown>).status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_115_CS: Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is true
 * Use case: I11 (I11.FR.03, I11.FR.06, I11.FR.07)
 */
export const TC_I_115_CS: CsTestCase = {
  id: 'TC_I_115_CS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is true',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose:
    'To verify if the Charging Station correctly validates the tariff change when conditions are supported.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: ChangeTransactionTariff with conditions - expect Accepted
    const res = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem99',
        currency: 'EUR',
        energy: {
          prices: [
            {
              priceKwh: 1.0,
              conditions: { startTimeOfDay: '00:00', endTimeOfDay: '00:00', evseKind: 'AC' },
            },
          ],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'ChangeTransactionTariffResponse Accepted',
      status: (res as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res as Record<string, unknown>).status)}`,
    });

    // Step 3: Wait for TransactionEventRequest with TariffChanged
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = (txPayload as Record<string, unknown>).triggerReason;
    const txInfo = (txPayload as Record<string, unknown>).transactionInfo as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEventRequest TariffChanged with TestSystem99',
      status:
        trigger === 'TariffChanged' && txInfo?.tariffId === 'TestSystem99' ? 'passed' : 'failed',
      expected: 'triggerReason TariffChanged, tariffId TestSystem99',
      actual: `trigger: ${String(trigger)}, tariffId: ${String(txInfo?.tariffId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_116_CS: Local Cost Calculation - Change transaction tariff - goodflow
 * Use case: I11 (I11.FR.06, I11.FR.08)
 */
export const TC_I_116_CS: CsTestCase = {
  id: 'TC_I_116_CS',
  name: 'Local Cost Calculation - Change transaction tariff - goodflow',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose: 'To verify if the Charging Station correctly validates the tariff change.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: SetDefaultTariff
    const setRes = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        chargingTime: { prices: [{ priceMinute: 0.1 }], taxRates: [{ tax: 0, type: 'VAT' }] },
      },
    });
    steps.push({
      step: 2,
      description: 'SetDefaultTariffResponse Accepted',
      status: (setRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((setRes as Record<string, unknown>).status)}`,
    });

    // Step 8-9: ChangeTransactionTariff
    const changeRes = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem99',
        currency: 'EUR',
        chargingTime: { prices: [{ priceMinute: 1.0 }], taxRates: [{ tax: 0, type: 'VAT' }] },
      },
    });
    steps.push({
      step: 9,
      description: 'ChangeTransactionTariffResponse Accepted',
      status: (changeRes as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((changeRes as Record<string, unknown>).status)}`,
    });

    // Step 10: Wait for TariffChanged TransactionEvent
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = (txPayload as Record<string, unknown>).triggerReason;
    const txInfo = (txPayload as Record<string, unknown>).transactionInfo as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 10,
      description: 'TransactionEventRequest TariffChanged',
      status:
        trigger === 'TariffChanged' && txInfo?.tariffId === 'TestSystem99' ? 'passed' : 'failed',
      expected: 'triggerReason TariffChanged, tariffId TestSystem99',
      actual: `trigger: ${String(trigger)}, tariffId: ${String(txInfo?.tariffId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_117_CS: Local Cost Calculation - Change transaction tariff - validations
 * Use case: I11 (I11.FR.04, I11.FR.05)
 */
export const TC_I_117_CS: CsTestCase = {
  id: 'TC_I_117_CS',
  name: 'Local Cost Calculation - Change transaction tariff - validations',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS changes the tariff that is associated with a transaction.',
  purpose: 'To verify if the Charging Station correctly validates the tariff change.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: Unknown transactionId - expect TxNotFound
    const res1 = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'UNKNOWN-TX-ID',
      tariff: {
        tariffId: 'TestSystem99',
        currency: 'EUR',
        chargingTime: { prices: [{ priceMinute: 6.0 }] },
      },
    });
    steps.push({
      step: 2,
      description: 'ChangeTransactionTariffResponse TxNotFound',
      status: (res1 as Record<string, unknown>).status === 'TxNotFound' ? 'passed' : 'failed',
      expected: 'status TxNotFound',
      actual: `status: ${String((res1 as Record<string, unknown>).status)}`,
    });

    // Step 3-4: Valid transactionId - expect Accepted
    const res2 = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        chargingTime: { prices: [{ priceMinute: 6.0 }] },
      },
    });
    steps.push({
      step: 4,
      description: 'ChangeTransactionTariffResponse Accepted',
      status: (res2 as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res2 as Record<string, unknown>).status)}`,
    });

    // Step 5-6: Different currency - expect NoCurrencyChange
    const res3 = await ctx.server.sendCommand('ChangeTransactionTariff', {
      transactionId: 'test-tx',
      tariff: {
        tariffId: 'TestSystem2',
        currency: 'ALL',
        chargingTime: { prices: [{ priceMinute: 6.0 }] },
      },
    });
    steps.push({
      step: 6,
      description: 'ChangeTransactionTariffResponse NoCurrencyChange',
      status: (res3 as Record<string, unknown>).status === 'NoCurrencyChange' ? 'passed' : 'failed',
      expected: 'status NoCurrencyChange',
      actual: `status: ${String((res3 as Record<string, unknown>).status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
