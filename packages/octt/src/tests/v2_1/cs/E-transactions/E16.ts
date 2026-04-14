// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState, waitForTriggerReason } from '../../../../cs-test-helpers.js';

/** Base handler that accepts all standard messages. Used by tests that don't need custom responses. */
function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
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
}

/**
 * Create a handler that returns transactionLimit based on triggerReason/eventType.
 * Uses a counter for the specific triggerReason to control which occurrence gets a limit.
 */
function createLimitHandler(
  limitSchedule: Array<{
    match: (action: string, payload: Record<string, unknown>, callIndex: number) => boolean;
    response: Record<string, unknown>;
  }>,
): (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>> {
  let callIndex = 0;
  return async (action: string, payload: Record<string, unknown>) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') {
      callIndex++;
      for (const entry of limitSchedule) {
        if (entry.match(action, payload, callIndex)) {
          return entry.response;
        }
      }
      return {};
    }
    return {};
  };
}

/**
 * Start charging with a short meter interval for faster limit testing.
 * Sets SampledDataCtrlr.TxUpdatedInterval to 2 seconds.
 */
async function startChargingFast(
  ctx: {
    station: {
      setConfigValue(k: string, v: string): void;
      plugIn(e: number): Promise<void>;
      startCharging(e: number, t: string): Promise<unknown>;
    };
    server: { waitForMessage(a: string, t: number): Promise<Record<string, unknown>> };
  },
  evseId: number,
  token: string,
): Promise<void> {
  ctx.station.setConfigValue('SampledDataCtrlr.TxUpdatedInterval', '2');
  await ctx.station.plugIn(evseId);
  await ctx.station.startCharging(evseId, token);
}

// ---------------------------------------------------------------------------
// TC_E_100_CS: CSMS specifies energy limit
// ---------------------------------------------------------------------------
export const TC_E_100_CS: CsTestCase = {
  id: 'TC_E_100_CS',
  name: 'Transactions with fixed cost, energy or time - CSMS specifies energy limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS will limit the transaction to the specified energy limit.',
  purpose:
    'To verify whether the Charging Station uses the specified energy limit to limit the transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxEnergy 2000 Wh on Started, maxEnergy 30 Wh on first LimitSet
    // At ~22kW, each 2s tick adds ~12 Wh, so 30 Wh limit is hit in 3 ticks (6s)
    let limitSetCount = 0;
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) => (p['eventType'] as string) === 'Started',
          response: { transactionLimit: { maxEnergy: 2000 } },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'LimitSet') {
              limitSetCount++;
              return limitSetCount === 1;
            }
            return false;
          },
          response: { transactionLimit: { maxEnergy: 30 } },
        },
      ]),
    );

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet with maxEnergy 2000 (from Started response)
    const ls1 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls1Info = (ls1?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxEnergy 2000',
      status:
        ls1?.['eventType'] === 'Updated' &&
        ls1?.['triggerReason'] === 'LimitSet' &&
        ls1Info?.['maxEnergy'] === 2000
          ? 'passed'
          : 'failed',
      expected: 'eventType Updated, triggerReason LimitSet, maxEnergy 2000',
      actual: `eventType=${ls1?.['eventType']}, triggerReason=${ls1?.['triggerReason']}, maxEnergy=${ls1Info?.['maxEnergy']}`,
    });

    // Step 2: LimitSet with maxEnergy 30 (from response to first LimitSet)
    const ls2 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls2Info = (ls2?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxEnergy 30',
      status:
        ls2?.['triggerReason'] === 'LimitSet' && ls2Info?.['maxEnergy'] === 30
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxEnergy 30',
      actual: `triggerReason=${ls2?.['triggerReason']}, maxEnergy=${ls2Info?.['maxEnergy']}`,
    });

    // Step 3: EnergyLimitReached (30 Wh hit in ~3 ticks at 22 kW with 2s interval)
    const elr = await waitForTriggerReason(ctx.server, 'EnergyLimitReached', 30_000);
    const elrInfo = (elr?.['transactionInfo'] as Record<string, unknown>) ?? {};
    const elrState = elrInfo['chargingState'] as string | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent EnergyLimitReached',
      status:
        elr?.['triggerReason'] === 'EnergyLimitReached' &&
        (elrState === 'SuspendedEVSE' || elrState === 'EVConnected')
          ? 'passed'
          : 'failed',
      expected: 'triggerReason EnergyLimitReached, chargingState SuspendedEVSE/EVConnected',
      actual: `triggerReason=${elr?.['triggerReason']}, chargingState=${elrState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_101_CS: CSMS calculates costs and specifies maxCost limit
// ---------------------------------------------------------------------------
export const TC_E_101_CS: CsTestCase = {
  id: 'TC_E_101_CS',
  name: 'Transactions with fixed cost, energy or time - CSMS calculates costs and specifies limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CS will set a limit the transaction for the specified cost. CS will use running cost calculation provided by CSMS.',
  purpose:
    'To verify whether the Charging Station uses the running cost calculation provided by CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxCost 45.30 on Started, then totalCost exceeding maxCost on periodic
    let periodicCount = 0;
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) => (p['eventType'] as string) === 'Started',
          response: { transactionLimit: { maxCost: 45.3 } },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'MeterValuePeriodic') {
              periodicCount++;
              // On third periodic, send totalCost that exceeds maxCost
              return periodicCount >= 3;
            }
            return false;
          },
          response: { totalCost: 50.0 },
        },
      ]),
    );

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxCost 45.30
    const ls = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const lsInfo = (ls?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxCost 45.30',
      status:
        ls?.['eventType'] === 'Updated' &&
        ls?.['triggerReason'] === 'LimitSet' &&
        lsInfo?.['maxCost'] === 45.3
          ? 'passed'
          : 'failed',
      expected: 'eventType Updated, triggerReason LimitSet, maxCost 45.30',
      actual: `eventType=${ls?.['eventType']}, triggerReason=${ls?.['triggerReason']}, maxCost=${lsInfo?.['maxCost']}`,
    });

    // Step 2: CostLimitReached (totalCost 50.0 exceeds maxCost 45.30)
    const clr = await waitForTriggerReason(ctx.server, 'CostLimitReached', 30_000);
    const clrInfo = (clr?.['transactionInfo'] as Record<string, unknown>) ?? {};
    const clrState = clrInfo['chargingState'] as string | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent CostLimitReached',
      status:
        clr?.['triggerReason'] === 'CostLimitReached' &&
        (clrState === 'SuspendedEVSE' || clrState === 'EVConnected')
          ? 'passed'
          : 'failed',
      expected: 'triggerReason CostLimitReached, chargingState SuspendedEVSE/EVConnected',
      actual: `triggerReason=${clr?.['triggerReason']}, chargingState=${clrState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_102_CS: CSMS and CS both specify limits
// ---------------------------------------------------------------------------
export const TC_E_102_CS: CsTestCase = {
  id: 'TC_E_102_CS',
  name: 'Transactions with fixed cost, energy or time - CSMS and CS both specify limits',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS will limit the transaction to the specified energy and time limit. CS will add its own limits for energy.',
  purpose: 'To verify whether the Charging Station uses the most limiting specified limits.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxEnergy 20000 Wh on Started, maxEnergy 30 Wh on first LimitSet
    // At ~22kW, each 2s tick adds ~12 Wh, so 30 Wh limit is hit in ~3 ticks
    let limitSetCount = 0;
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) => (p['eventType'] as string) === 'Started',
          response: { transactionLimit: { maxEnergy: 20000 } },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'LimitSet') {
              limitSetCount++;
              return limitSetCount === 1;
            }
            return false;
          },
          response: { transactionLimit: { maxEnergy: 30 } },
        },
      ]),
    );

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxEnergy 20000
    const ls1 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls1Info = (ls1?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxEnergy 20000',
      status:
        ls1?.['triggerReason'] === 'LimitSet' && ls1Info?.['maxEnergy'] === 20000
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxEnergy 20000',
      actual: `triggerReason=${ls1?.['triggerReason']}, maxEnergy=${ls1Info?.['maxEnergy']}`,
    });

    // Step 2: LimitSet maxEnergy 30 (CSMS lowered the limit)
    const ls2 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls2Info = (ls2?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxEnergy 30',
      status:
        ls2?.['triggerReason'] === 'LimitSet' && ls2Info?.['maxEnergy'] === 30
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxEnergy 30',
      actual: `triggerReason=${ls2?.['triggerReason']}, maxEnergy=${ls2Info?.['maxEnergy']}`,
    });

    // Step 3: EnergyLimitReached
    const elr = await waitForTriggerReason(ctx.server, 'EnergyLimitReached', 30_000);
    const elrInfo = (elr?.['transactionInfo'] as Record<string, unknown>) ?? {};
    const elrState = elrInfo['chargingState'] as string | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent EnergyLimitReached',
      status:
        elr?.['triggerReason'] === 'EnergyLimitReached' &&
        (elrState === 'SuspendedEVSE' || elrState === 'EVConnected')
          ? 'passed'
          : 'failed',
      expected: 'triggerReason EnergyLimitReached',
      actual: `triggerReason=${elr?.['triggerReason']}, chargingState=${elrState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_103_CS: CS calculates costs and CSMS specifies maxCost limit
// ---------------------------------------------------------------------------
export const TC_E_103_CS: CsTestCase = {
  id: 'TC_E_103_CS',
  name: 'Transactions with fixed cost, energy or time - CS calculates costs and CSMS specifies limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS will set a limit the transaction for the specified cost. CS will use local cost calculation.',
  purpose: 'To verify whether the Charging Station correctly uses local cost calculation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxCost on Started
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) => (p['eventType'] as string) === 'Started',
          response: { transactionLimit: { maxCost: 2.0 } },
        },
      ]),
    );

    // Step 1: CSMS sends SetDefaultTariff (high rate so cost accrues fast)
    const setTariffResp = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'Tariff1',
        currency: 'EUR',
        chargingTime: { taxRate: [{ type: 'MyTax1', tax: 0 }], prices: [{ priceMinute: 60 }] },
        idleTime: { taxRate: [{ type: 'MyTax2', tax: 0 }], prices: [{ priceMinute: 60 }] },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDefaultTariffResponse received',
      status: setTariffResp ? 'passed' : 'failed',
      expected: 'SetDefaultTariffResponse',
      actual: setTariffResp ? 'Received' : 'Timeout',
    });

    // Start charging
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 2: LimitSet maxCost 2.00
    const ls = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const lsInfo = (ls?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxCost 2.00',
      status:
        ls?.['triggerReason'] === 'LimitSet' && lsInfo?.['maxCost'] === 2.0 ? 'passed' : 'failed',
      expected: 'triggerReason LimitSet, maxCost 2.00',
      actual: `triggerReason=${ls?.['triggerReason']}, maxCost=${lsInfo?.['maxCost']}`,
    });

    // Step 3: CostLimitReached (local cost calculation exceeds maxCost at 60/min rate)
    const clr = await waitForTriggerReason(ctx.server, 'CostLimitReached', 30_000);
    steps.push({
      step: 3,
      description: 'TransactionEvent CostLimitReached',
      status: clr?.['triggerReason'] === 'CostLimitReached' ? 'passed' : 'failed',
      expected: 'triggerReason CostLimitReached',
      actual: `triggerReason=${clr?.['triggerReason']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_104_CS: CSMS calculates costs via TransactionEventResponse
// ---------------------------------------------------------------------------
export const TC_E_104_CS: CsTestCase = {
  id: 'TC_E_104_CS',
  name: 'Transactions with fixed cost, energy or time - CSMS calculates costs (through TransactionEventResponse)',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS will set a limit the transaction for the specified cost. CS will use running cost calculation provided by CSMS.',
  purpose:
    'To verify whether the Charging Station uses the running cost calculation provided by CSMS via TransactionEventResponse.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxCost on Started/ChargingStateChanged, then totalCost on periodic
    let periodicCount = 0;
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) =>
            (p['eventType'] as string) === 'Started' ||
            (p['triggerReason'] as string) === 'ChargingStateChanged',
          response: { transactionLimit: { maxCost: 99.13 } },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'MeterValuePeriodic') {
              periodicCount++;
              if (periodicCount === 1) return true;
            }
            return false;
          },
          response: { totalCost: 50.34 },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'MeterValuePeriodic') {
              return periodicCount >= 2;
            }
            return false;
          },
          response: { totalCost: 120.34 },
        },
      ]),
    );

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxCost 99.13
    const ls = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const lsInfo = (ls?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxCost 99.13',
      status:
        ls?.['eventType'] === 'Updated' &&
        ls?.['triggerReason'] === 'LimitSet' &&
        lsInfo?.['maxCost'] === 99.13
          ? 'passed'
          : 'failed',
      expected: 'eventType Updated, triggerReason LimitSet, maxCost 99.13',
      actual: `eventType=${ls?.['eventType']}, triggerReason=${ls?.['triggerReason']}, maxCost=${lsInfo?.['maxCost']}`,
    });

    // Step 2: CostLimitReached (totalCost 120.34 exceeds maxCost 99.13)
    const clr = await waitForTriggerReason(ctx.server, 'CostLimitReached', 30_000);
    const clrInfo = (clr?.['transactionInfo'] as Record<string, unknown>) ?? {};
    const clrState = clrInfo['chargingState'] as string | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent CostLimitReached',
      status:
        clr?.['triggerReason'] === 'CostLimitReached' &&
        (clrState === 'SuspendedEVSE' || clrState === 'EVConnected')
          ? 'passed'
          : 'failed',
      expected: 'triggerReason CostLimitReached',
      actual: `triggerReason=${clr?.['triggerReason']}, chargingState=${clrState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_105_CS: CSMS specifies time limit
// ---------------------------------------------------------------------------
export const TC_E_105_CS: CsTestCase = {
  id: 'TC_E_105_CS',
  name: 'Transactions with fixed cost, energy or time - CSMS specifies time limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS will limit the transaction to the specified time limit.',
  purpose:
    'To verify whether the Charging Station uses the specified time limit to limit the transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Handler: return maxTime 3600s on Started, then maxTime 5s on first LimitSet
    let limitSetCount = 0;
    ctx.server.setMessageHandler(
      createLimitHandler([
        {
          match: (_a, p) => (p['eventType'] as string) === 'Started',
          response: { transactionLimit: { maxTime: 3600 } },
        },
        {
          match: (_a, p) => {
            if ((p['triggerReason'] as string) === 'LimitSet') {
              limitSetCount++;
              return limitSetCount === 1;
            }
            return false;
          },
          response: { transactionLimit: { maxTime: 5 } },
        },
      ]),
    );

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxTime 3600
    const ls1 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls1Info = (ls1?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxTime 3600',
      status:
        ls1?.['triggerReason'] === 'LimitSet' && ls1Info?.['maxTime'] === 3600
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxTime 3600',
      actual: `triggerReason=${ls1?.['triggerReason']}, maxTime=${ls1Info?.['maxTime']}`,
    });

    // Step 2: LimitSet maxTime 5 (CSMS lowered the time limit)
    const ls2 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls2Info = (ls2?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxTime 5',
      status:
        ls2?.['triggerReason'] === 'LimitSet' && ls2Info?.['maxTime'] === 5 ? 'passed' : 'failed',
      expected: 'triggerReason LimitSet, maxTime 5',
      actual: `triggerReason=${ls2?.['triggerReason']}, maxTime=${ls2Info?.['maxTime']}`,
    });

    // Step 3: TimeLimitReached (5s from transaction start should be hit quickly)
    const tlr = await waitForTriggerReason(ctx.server, 'TimeLimitReached', 30_000);
    const tlrInfo = (tlr?.['transactionInfo'] as Record<string, unknown>) ?? {};
    const tlrState = tlrInfo['chargingState'] as string | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent TimeLimitReached',
      status:
        tlr?.['triggerReason'] === 'TimeLimitReached' &&
        (tlrState === 'SuspendedEVSE' || tlrState === 'EVConnected')
          ? 'passed'
          : 'failed',
      expected: 'triggerReason TimeLimitReached',
      actual: `triggerReason=${tlr?.['triggerReason']}, chargingState=${tlrState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_106_CS: CS specifies energy limit (driver-set)
// ---------------------------------------------------------------------------
export const TC_E_106_CS: CsTestCase = {
  id: 'TC_E_106_CS',
  name: 'Transactions with fixed cost, energy or time - CS specifies energy limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV Driver is able to specify an energy limit.',
  purpose:
    'To verify whether the Charging Station uses the specified energy limit to limit the transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Set driver energy limit of 20000 Wh before starting
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyLimit', '20000');

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxEnergy 20000
    const ls1 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls1Info = (ls1?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxEnergy 20000',
      status:
        (ls1?.['triggerReason'] === 'LimitSet' ||
          ls1?.['triggerReason'] === 'MeterValuePeriodic') &&
        ls1Info?.['maxEnergy'] === 20000
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet/MeterValuePeriodic, maxEnergy 20000',
      actual: `triggerReason=${ls1?.['triggerReason']}, maxEnergy=${ls1Info?.['maxEnergy']}`,
    });

    // Change driver energy limit to 200 Wh (will be hit quickly)
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyLimit', '200');

    // Step 2: LimitSet maxEnergy 200
    const ls2 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls2Info = (ls2?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxEnergy 200',
      status:
        (ls2?.['triggerReason'] === 'LimitSet' ||
          ls2?.['triggerReason'] === 'MeterValuePeriodic') &&
        ls2Info?.['maxEnergy'] === 200
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxEnergy 200',
      actual: `triggerReason=${ls2?.['triggerReason']}, maxEnergy=${ls2Info?.['maxEnergy']}`,
    });

    // Step 3: EnergyLimitReached
    const elr = await waitForTriggerReason(ctx.server, 'EnergyLimitReached', 30_000);
    steps.push({
      step: 3,
      description: 'TransactionEvent EnergyLimitReached',
      status: elr?.['triggerReason'] === 'EnergyLimitReached' ? 'passed' : 'failed',
      expected: 'triggerReason EnergyLimitReached',
      actual: `triggerReason=${elr?.['triggerReason']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_107_CS: CS specifies time limit (driver-set)
// ---------------------------------------------------------------------------
export const TC_E_107_CS: CsTestCase = {
  id: 'TC_E_107_CS',
  name: 'Transactions with fixed cost, energy or time - CS specifies time limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV Driver is able to specify a time limit.',
  purpose:
    'To verify whether the Charging Station uses the specified time limit to limit the transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Set driver time limit of 3600s before starting
    ctx.station.setConfigValue('TxCtrlr.MaxTimeLimit', '3600');

    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: LimitSet maxTime 3600
    const ls1 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls1Info = (ls1?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Updated LimitSet maxTime 3600',
      status:
        ls1?.['triggerReason'] === 'LimitSet' && ls1Info?.['maxTime'] === 3600
          ? 'passed'
          : 'failed',
      expected: 'triggerReason LimitSet, maxTime 3600',
      actual: `triggerReason=${ls1?.['triggerReason']}, maxTime=${ls1Info?.['maxTime']}`,
    });

    // Change driver time limit to 5s (will be hit quickly)
    ctx.station.setConfigValue('TxCtrlr.MaxTimeLimit', '5');

    // Step 2: LimitSet maxTime 5
    const ls2 = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const ls2Info = (ls2?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated LimitSet maxTime 5',
      status:
        ls2?.['triggerReason'] === 'LimitSet' && ls2Info?.['maxTime'] === 5 ? 'passed' : 'failed',
      expected: 'triggerReason LimitSet, maxTime 5',
      actual: `triggerReason=${ls2?.['triggerReason']}, maxTime=${ls2Info?.['maxTime']}`,
    });

    // Step 3: TimeLimitReached
    const tlr = await waitForTriggerReason(ctx.server, 'TimeLimitReached', 30_000);
    steps.push({
      step: 3,
      description: 'TransactionEvent TimeLimitReached',
      status: tlr?.['triggerReason'] === 'TimeLimitReached' ? 'passed' : 'failed',
      expected: 'triggerReason TimeLimitReached',
      actual: `triggerReason=${tlr?.['triggerReason']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// ---------------------------------------------------------------------------
// TC_E_108_CS: CS calculates costs and specifies limit (driver-set maxCost)
// ---------------------------------------------------------------------------
export const TC_E_108_CS: CsTestCase = {
  id: 'TC_E_108_CS',
  name: 'Transactions with fixed cost, energy or time - CS calculates costs and specifies limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CS will set a limit the transaction for the specified cost. CS will use local cost calculation.',
  purpose: 'To verify whether the Charging Station correctly uses local cost calculation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1: CSMS sends SetDefaultTariff (high rate: 60 EUR/min charging time)
    const tariffResp = await ctx.server.sendCommand('SetDefaultTariff', {
      evseId: 0,
      tariff: {
        tariffId: 'TestSystem1',
        currency: 'EUR',
        chargingTime: {
          prices: [{ priceMinute: 60.0 }],
          taxRates: [{ type: 'No Tax', tax: 0 }],
        },
        idleTime: {
          prices: [{ priceMinute: 60.0 }],
          taxRates: [{ type: 'No Tax', tax: 0 }],
        },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDefaultTariffResponse received',
      status: tariffResp ? 'passed' : 'failed',
      expected: 'SetDefaultTariffResponse',
      actual: tariffResp ? 'Received' : 'Timeout',
    });

    // Start charging (no maxCost set yet so RunningCost fires first)
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 2: RunningCost with costDetails (local cost calculation active)
    const rc = await waitForTriggerReason(ctx.server, 'RunningCost', 10_000);
    const costDetails = rc?.['costDetails'] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Updated RunningCost with costDetails',
      status: rc?.['triggerReason'] === 'RunningCost' && costDetails != null ? 'passed' : 'failed',
      expected: 'triggerReason RunningCost, costDetails present',
      actual: `triggerReason=${rc?.['triggerReason']}, costDetails=${costDetails ? 'present' : 'missing'}`,
    });

    // Set driver cost limit of 2.00 EUR (after RunningCost, before next tick)
    ctx.station.setConfigValue('TxCtrlr.MaxCostLimit', '2');

    // Step 3: LimitSet maxCost 2.00 (driver-set limit, detected on next tick)
    const ls = await waitForTriggerReason(ctx.server, 'LimitSet', 10_000);
    const lsInfo = (ls?.['transactionInfo'] as Record<string, unknown>)?.['transactionLimit'] as
      | Record<string, unknown>
      | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent Updated LimitSet maxCost 2.00',
      status:
        ls?.['triggerReason'] === 'LimitSet' && lsInfo?.['maxCost'] === 2.0 ? 'passed' : 'failed',
      expected: 'triggerReason LimitSet, maxCost 2.00',
      actual: `triggerReason=${ls?.['triggerReason']}, maxCost=${lsInfo?.['maxCost']}`,
    });

    // Step 4: CostLimitReached (local cost exceeds 2.00 EUR at 60 EUR/min)
    const clr = await waitForTriggerReason(ctx.server, 'CostLimitReached', 30_000);
    steps.push({
      step: 4,
      description: 'TransactionEvent CostLimitReached',
      status: clr?.['triggerReason'] === 'CostLimitReached' ? 'passed' : 'failed',
      expected: 'triggerReason CostLimitReached',
      actual: `triggerReason=${clr?.['triggerReason']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
