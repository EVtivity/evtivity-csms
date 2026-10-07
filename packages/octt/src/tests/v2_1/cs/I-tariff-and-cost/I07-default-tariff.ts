// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import {
  collectMessages,
  setVariables,
  sleep,
  waitForChargingState,
} from '../../../../cs-test-helpers.js';

const MODULE = 'I-tariff-and-cost';
const EVSE_ID = 1;
const TOKEN = 'OCTT-TOKEN-001';
const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');
const result = (steps: StepResult[]): TestResult => ({
  status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
  durationMs: 0,
  steps,
});

function useCsmsHandler(ctx: CsTestContext): void {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

const create = (
  id: string,
  name: string,
  purpose: string,
  execute: (ctx: CsTestContext) => Promise<TestResult>,
): CsTestCase => ({
  id,
  name,
  module: MODULE,
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a default tariff on the Charging Station for local cost calculation.',
  purpose,
  execute,
});

/** Configuration State: TariffCostCtrlr.Enabled[Tariff] is true. */
async function tariffEnabled(
  ctx: CsTestContext,
  steps: StepResult[],
  enabled = true,
): Promise<void> {
  const notAccepted = await setVariables(ctx.server, [
    {
      component: 'TariffCostCtrlr',
      variable: 'Enabled',
      instance: 'Tariff',
      value: String(enabled),
    },
  ]);
  steps.push({
    step: 0,
    description: `Before: TariffCostCtrlr.Enabled[Tariff] ${String(enabled)}`,
    status: passOrFail(notAccepted.length === 0),
    expected: 'Accepted',
    actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
  });
}

const prices = (n: number, field: string, value: number): Array<Record<string, number>> =>
  Array.from({ length: n }, () => ({ [field]: value }));

async function setDefaultTariff(
  ctx: CsTestContext,
  step: number,
  steps: StepResult[],
  tariff: Record<string, unknown>,
  expected: string,
  evseId = 0,
  reasonCodes?: string[],
): Promise<void> {
  const resp = await ctx.server.sendCommand('SetDefaultTariff', {
    evseId,
    tariff: { currency: 'EUR', ...tariff },
  });
  const reason = (resp['statusInfo'] as Record<string, unknown> | undefined)?.['reasonCode'];
  steps.push({
    step,
    description: `SetDefaultTariffResponse ${expected} (${String(tariff['tariffId'])}, EVSE ${String(evseId)})`,
    status: passOrFail(
      resp['status'] === expected &&
        (reasonCodes == null || reason == null || reasonCodes.includes(String(reason))),
    ),
    expected:
      reasonCodes != null
        ? `${expected}, reasonCode ${reasonCodes.join('/')} or omitted`
        : expected,
    actual: `${String(resp['status'])}${reason != null ? `, ${String(reason)}` : ''}`,
  });
}

export const TC_I_102_CS = create(
  'TC_I_102_CS',
  'Set Default Tariff - TariffMaxElements',
  'To verify that the Charging Station rejects a tariff with more price elements than TariffMaxElements.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await tariffEnabled(ctx, steps);
    const get = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'TariffCostCtrlr' },
          variable: { name: 'MaxElements', instance: 'Tariff' },
        },
      ],
    });
    const r = ((get['getVariableResult'] ?? []) as Array<Record<string, unknown>>)[0];
    const variable = r?.['variable'] as Record<string, unknown> | undefined;
    const max = Number(r?.['attributeValue']);
    steps.push({
      step: 2,
      description: 'GetVariablesResponse TariffCostCtrlr.MaxElements[Tariff]',
      status: passOrFail(
        (r?.['component'] as Record<string, unknown> | undefined)?.['name'] === 'TariffCostCtrlr' &&
          variable?.['name'] === 'MaxElements' &&
          variable['instance'] === 'Tariff' &&
          Number.isInteger(max) &&
          max > 0,
      ),
      expected: 'TariffCostCtrlr.MaxElements[Tariff] with a value',
      actual: JSON.stringify(r),
    });
    if (!(Number.isInteger(max) && max > 0)) return result(steps);
    const energy = (n: number) => ({ prices: prices(n, 'priceKwh', 1.0) });
    const minutes = (n: number) => ({ prices: prices(n, 'priceMinute', 1.0) });
    const fixed = (n: number) => ({ prices: prices(n, 'priceFixed', 1.0) });
    await setDefaultTariff(
      ctx,
      4,
      steps,
      { tariffId: 'Test System1', energy: energy(max + 1) },
      'TooManyElements',
    );
    await setDefaultTariff(
      ctx,
      6,
      steps,
      { tariffId: 'Test System1', energy: energy(max) },
      'Accepted',
    );
    await setDefaultTariff(
      ctx,
      8,
      steps,
      { tariffId: 'Test System2', energy: energy(max), chargingTime: minutes(max + 1) },
      'TooManyElements',
    );
    await setDefaultTariff(
      ctx,
      10,
      steps,
      { tariffId: 'Test System2', energy: energy(max), chargingTime: minutes(max) },
      'Accepted',
    );
    await setDefaultTariff(
      ctx,
      12,
      steps,
      {
        tariffId: 'Test System3',
        energy: energy(max),
        chargingTime: minutes(max),
        idleTime: minutes(max + 1),
      },
      'TooManyElements',
    );
    await setDefaultTariff(
      ctx,
      14,
      steps,
      {
        tariffId: 'Test System3',
        energy: energy(max),
        chargingTime: minutes(max),
        idleTime: minutes(max),
      },
      'Accepted',
    );
    await setDefaultTariff(
      ctx,
      16,
      steps,
      {
        tariffId: 'Test System4',
        energy: energy(max),
        chargingTime: minutes(max),
        idleTime: minutes(max),
        fixedFee: fixed(max + 1),
      },
      'TooManyElements',
    );
    await setDefaultTariff(
      ctx,
      18,
      steps,
      {
        tariffId: 'Test System4',
        energy: energy(max),
        chargingTime: minutes(max),
        idleTime: minutes(max),
        fixedFee: fixed(max),
      },
      'Accepted',
    );
    await setDefaultTariff(
      ctx,
      20,
      steps,
      { tariffId: 'Test System4', energy: { prices: [{ priceKwh: 2.0 }] } },
      'DuplicateTariffId',
    );
    return result(steps);
  },
);

export const TC_I_103_CS = create(
  'TC_I_103_CS',
  'Set Default Tariff - CS doesn’t support local cost calculation',
  'To verify that the Charging Station answers NotSupported when local cost calculation is disabled.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    // Configuration State: TariffCostCtrlr.Enabled[Tariff] is false
    await tariffEnabled(ctx, steps, false);
    let error = '';
    try {
      await ctx.server.sendCommand('SetDefaultTariff', {
        evseId: 0,
        tariff: {
          tariffId: 'Test System1',
          currency: 'EUR',
          energy: { taxRates: [{ type: 'MyTax1', tax: 20 }], prices: [{ priceKwh: 1.0 }] },
        },
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    steps.push({
      step: 2,
      description: 'CALLERROR NotSupported or NotImplemented',
      status: passOrFail(/CALLERROR (NotSupported|NotImplemented)/.test(error)),
      expected: 'CALLERROR NotSupported or NotImplemented',
      actual: error || 'a response',
    });
    return result(steps);
  },
);

export const TC_I_104_CS = create(
  'TC_I_104_CS',
  'Set Default Tariff - transaction with default tariff',
  'To verify that a transaction uses the default tariff.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await tariffEnabled(ctx, steps);
    await setDefaultTariff(
      ctx,
      2,
      steps,
      { tariffId: 'Test System1', energy: { prices: [{ priceKwh: 2.0 }] } },
      'Accepted',
    );
    await ctx.station.plugIn(EVSE_ID);
    await ctx.station.authorize(EVSE_ID, TOKEN);
    const seen: Array<Record<string, unknown>> = [];
    const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
    if (charging != null) seen.push(charging);
    seen.push(...(await collectMessages(ctx.server, 'TransactionEvent', 1000, 3000)));
    const withTariff = seen.find(
      (m) =>
        (m['transactionInfo'] as Record<string, unknown> | undefined)?.['tariffId'] ===
        'Test System1',
    );
    steps.push({
      step: 3,
      description: 'A TransactionEventRequest has transactionInfo.tariffId Test System1',
      status: passOrFail(withTariff != null),
      expected: 'tariffId Test System1',
      actual: seen
        .map((m) =>
          String((m['transactionInfo'] as Record<string, unknown> | undefined)?.['tariffId']),
        )
        .join(', '),
    });
    return result(steps);
  },
);

export const TC_I_105_CS = create(
  'TC_I_105_CS',
  'Set Default Tariff - TariffConditionsSupported is false',
  'To verify that a Charging Station without tariff conditions rejects a tariff with conditions.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await tariffEnabled(ctx, steps);
    await setDefaultTariff(
      ctx,
      2,
      steps,
      {
        tariffId: 'Test System1',
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
                minCurrent: 1,
                maxCurrent: 10,
                minPower: 1000,
                maxPower: 10000,
                minTime: 0,
                maxTime: 3600,
                minChargingTime: 0,
                maxChargingTime: 3600,
                minIdleTime: 0,
                maxIdleTime: 3600,
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
          prices: [
            { priceFixed: 1.0, conditions: { paymentBrand: 'PayMe', paymentRecognition: 'Debit' } },
          ],
        },
      },
      'ConditionNotSupported',
    );
    return result(steps);
  },
);

export const TC_I_106_CS = create(
  'TC_I_106_CS',
  'Set Default Tariff - validations',
  'To verify the validations of SetDefaultTariffRequest and the resulting tariff assignments.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await tariffEnabled(ctx, steps);
    const kwh = (v: number) => ({ prices: [{ priceKwh: v }] });
    const min = { prices: [{ priceMinute: 1.0 }] };
    await setDefaultTariff(ctx, 2, steps, { tariffId: 'Test System1' }, 'Rejected', 0, [
      'InvalidValue',
    ]);
    await setDefaultTariff(ctx, 4, steps, { tariffId: 'Test System1', energy: kwh(1) }, 'Accepted');
    await setDefaultTariff(
      ctx,
      6,
      steps,
      { tariffId: 'Test System2', chargingTime: min },
      'Accepted',
    );
    await setDefaultTariff(ctx, 8, steps, { tariffId: 'Test System3', idleTime: min }, 'Accepted');
    await setDefaultTariff(
      ctx,
      10,
      steps,
      { tariffId: 'Test System4', fixedFee: { prices: [{ priceFixed: 1.0 }] } },
      'Accepted',
    );
    const evseCount = 1; // <Configured number of evse>
    await setDefaultTariff(
      ctx,
      12,
      steps,
      { tariffId: 'Test System5', energy: kwh(1) },
      'Rejected',
      evseCount + 1,
      ['UnknownEVSE'],
    );
    await setDefaultTariff(
      ctx,
      14,
      steps,
      { tariffId: 'Test System5', energy: kwh(2) },
      'Accepted',
      EVSE_ID,
    );

    const checkAssignments = async (step: number): Promise<void> => {
      const resp = await ctx.server.sendCommand('GetTariffs', { evseId: 0 });
      const assignments = (resp['tariffAssignments'] ?? []) as Array<Record<string, unknown>>;
      const ts5 = assignments.find((a) => a['tariffId'] === 'Test System5');
      steps.push({
        step,
        description:
          'GetTariffsResponse Accepted: Test System5 DefaultTariff on the configured EVSE',
        status: passOrFail(
          resp['status'] === 'Accepted' &&
            ts5?.['tariffKind'] === 'DefaultTariff' &&
            (ts5['evseIds'] as number[] | undefined)?.[0] === EVSE_ID &&
            assignments.length === 1,
        ),
        expected: `status Accepted, one assignment Test System5 / DefaultTariff / EVSE ${String(EVSE_ID)}`,
        actual: `${String(resp['status'])} ${JSON.stringify(assignments)}`,
      });
    };
    await checkAssignments(16);

    // Reusable State Booted with reset type Immediate
    const reset = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
    let booted = reset['status'] === 'Accepted';
    if ((await ctx.server.waitForMessageOrNull('BootNotification', 15_000)) == null) {
      booted = false;
    }
    steps.push({
      step: 17,
      description: 'Reusable State Booted (Reset Immediate)',
      status: passOrFail(booted),
      expected: 'Reset Accepted, BootNotification',
      actual: booted ? 'booted' : 'not booted',
    });
    await sleep(500);
    await checkAssignments(19);
    return result(steps);
  },
);

/** TC_I_120/121 need tariff conditions (PICS P-1); the simulator does not support them. */
export const TC_I_120_CS = create(
  'TC_I_120_CS',
  'Local Cost Calculation - Cost Details of Transaction - reservation',
  'To verify that the cost details of a transaction include the reservation price.',
  async () => ({
    status: 'failed',
    durationMs: 0,
    steps: [],
    error: 'Not runnable: needs tariff conditions (PICS P-1), reported notApplicable by the runner',
  }),
);

export const TC_I_121_CS = create(
  'TC_I_121_CS',
  'Local Cost Calculation - Cost Details of Transaction - minCost/maxCost',
  'To verify that the cost details of a transaction apply minCost and maxCost.',
  async () => ({
    status: 'failed',
    durationMs: 0,
    steps: [],
    error: 'Not runnable: needs tariff conditions (PICS P-1), reported notApplicable by the runner',
  }),
);
