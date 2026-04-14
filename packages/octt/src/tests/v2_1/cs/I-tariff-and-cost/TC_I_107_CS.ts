// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
// helpers not needed for this test

/**
 * TC_I_107_CS: Receive Driver Tariff - CS cannot process tariff - UseDefault/CentralCost
 * Use case: I08 (I08.FR.30, I08.FR.32, I08.FR.33)
 */
export const TC_I_107_CS: CsTestCase = {
  id: 'TC_I_107_CS',
  name: 'Receive Driver Tariff - CS cannot process tariff - UseDefault/CentralCost',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To support receiving the driver-specific tariff to enable local cost calculation based on a tariff for this driver.',
  purpose:
    'To verify if the Charging Station which does not support local cost calculation properly handles receiving a tariff.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize')
        return {
          idTokenInfo: { status: 'Accepted' },
          tariff: {
            tariffId: 'TestSystem1',
            currency: 'EUR',
            energy: { prices: [{ priceKwh: 2.0 }] },
          },
        };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Disable TariffCostCtrlr so the station reports a problem when receiving a tariff
    ctx.station.setConfigValue('TariffCostCtrlr.Enabled', 'false');

    // Step 1-2: SetDefaultTariff (the station should accept this even if cost ctrl is disabled)
    const res = await ctx.server.sendCommand('SetDefaultTariff', {
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
      status: (res as Record<string, unknown>).status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status Accepted',
      actual: `status: ${String((res as Record<string, unknown>).status)}`,
    });

    // Trigger authorize which includes a driver tariff in the response.
    // CSS should report TariffCostCtrlr Problem via NotifyEvent.
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Step 7: Wait for NotifyEventRequest reporting TariffCostCtrlr Problem
    // Multiple NotifyEvents may arrive (AvailabilityState, etc.), loop to find the right one
    let hasTariffProblem = false;
    const notifyDeadline = Date.now() + 10000;
    while (Date.now() < notifyDeadline) {
      try {
        const notifyPayload = await ctx.server.waitForMessage(
          'NotifyEvent',
          notifyDeadline - Date.now(),
        );
        const eventData = (notifyPayload as Record<string, unknown>).eventData as
          | Array<Record<string, unknown>>
          | undefined;
        if (
          eventData != null &&
          eventData.some((e) => {
            const component = e.component as Record<string, unknown> | undefined;
            const variable = e.variable as Record<string, unknown> | undefined;
            return component?.name === 'TariffCostCtrlr' && variable?.name === 'Problem';
          })
        ) {
          hasTariffProblem = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 7,
      description: 'NotifyEventRequest with TariffCostCtrlr Problem',
      status: hasTariffProblem ? 'passed' : 'failed',
      expected: 'component=TariffCostCtrlr, variable=Problem, actualValue=true',
      actual: hasTariffProblem ? 'TariffCostCtrlr Problem reported' : 'No matching event data',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_108_CS: Receive Driver Tariff - CS cannot process tariff - Deauthorize
 * Use case: I08 (I08.FR.30, I08.FR.31)
 */
export const TC_I_108_CS: CsTestCase = {
  id: 'TC_I_108_CS',
  name: 'Receive Driver Tariff - CS cannot process tariff - Deauthorize',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To support receiving the driver-specific tariff to enable local cost calculation based on a tariff for this driver.',
  purpose:
    'To verify if the Charging Station which does not support local cost calculation properly handles receiving a tariff by deauthorizing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize')
        return {
          idTokenInfo: { status: 'Accepted' },
          tariff: {
            tariffId: 'TestSystem1',
            currency: 'EUR',
            energy: { prices: [{ priceKwh: 2.0 }] },
          },
        };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Disable TariffCostCtrlr so the station reports a problem and deauthorizes
    ctx.station.setConfigValue('TariffCostCtrlr.Enabled', 'false');
    ctx.station.setConfigValue('TariffCostCtrlr.DeauthorizeOnProblem', 'true');

    // Trigger authorize with driver tariff
    await ctx.station.plugIn(1);
    try {
      await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    } catch {
      // startCharging fails because station deauthorizes; that is expected behavior
    }

    // Step 2: Wait for NotifyEventRequest with TariffCostCtrlr Problem
    // Multiple NotifyEvents may arrive (AvailabilityState, etc.), loop to find the right one
    let hasTariffProblem108 = false;
    const notifyDeadline108 = Date.now() + 10000;
    while (Date.now() < notifyDeadline108) {
      try {
        const notifyPayload = await ctx.server.waitForMessage(
          'NotifyEvent',
          notifyDeadline108 - Date.now(),
        );
        const eventData = (notifyPayload as Record<string, unknown>).eventData as
          | Array<Record<string, unknown>>
          | undefined;
        if (
          eventData != null &&
          eventData.some((e) => {
            const component = e.component as Record<string, unknown> | undefined;
            const variable = e.variable as Record<string, unknown> | undefined;
            return component?.name === 'TariffCostCtrlr' && variable?.name === 'Problem';
          })
        ) {
          hasTariffProblem108 = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 2,
      description: 'NotifyEventRequest with TariffCostCtrlr Problem',
      status: hasTariffProblem108 ? 'passed' : 'failed',
      expected: 'component=TariffCostCtrlr, variable=Problem, actualValue=true',
      actual: hasTariffProblem108 ? 'TariffCostCtrlr Problem reported' : 'No matching event data',
    });

    // Post: Charging Station shall not deliver energy - verify no Charging TransactionEvent
    try {
      const txPayload = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const chargingState = (
        (txPayload as Record<string, unknown>).transactionInfo as
          | Record<string, unknown>
          | undefined
      )?.chargingState;
      steps.push({
        step: 4,
        description: 'Charging Station shall not deliver energy',
        status: chargingState !== 'Charging' ? 'passed' : 'failed',
        expected: 'No TransactionEventRequest with ChargingState Charging',
        actual: `chargingState: ${String(chargingState)}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'Charging Station shall not deliver energy',
        status: 'passed',
        expected: 'No TransactionEventRequest with ChargingState Charging',
        actual: 'No TransactionEvent received (correct)',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_109_CS: Receive Driver Tariff - Goodflow
 * Use case: I08, I09 (I08.FR.04-07, I09.FR.03)
 */
export const TC_I_109_CS: CsTestCase = {
  id: 'TC_I_109_CS',
  name: 'Receive Driver Tariff - Goodflow',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To support receiving the driver-specific tariff to enable local cost calculation based on a tariff for this driver.',
  purpose: 'To verify if the Charging Station supports driver tariffs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize')
        return {
          idTokenInfo: { status: 'Accepted' },
          tariff: {
            tariffId: 'TestSystem1',
            currency: 'EUR',
            energy: { prices: [{ priceKwh: 2.0 }] },
          },
        };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Trigger authorize which includes a driver tariff in the response.
    // CSS TariffCostCtrlr.Enabled is true by default, so it should process the tariff.
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Step 2: Wait for TransactionEventRequest with tariffId
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const txInfo = (txPayload as Record<string, unknown>).transactionInfo as
      | Record<string, unknown>
      | undefined;
    const tariffId = txInfo?.tariffId;
    steps.push({
      step: 2,
      description: 'TransactionEventRequest with tariffId TestSystem1',
      status: tariffId === 'TestSystem1' ? 'passed' : 'failed',
      expected: 'transactionInfo.tariffId = TestSystem1',
      actual: `tariffId: ${String(tariffId)}`,
    });

    // Step 4-5: GetTariffs to verify driver tariff is stored
    const res = await ctx.server.sendCommand('GetTariffs', { evseId: 1 });
    const assignments = (res as Record<string, unknown>).tariffAssignments as
      | Array<Record<string, unknown>>
      | undefined;
    const hasDriverTariff =
      assignments != null &&
      assignments.some((a) => a.tariffId === 'TestSystem1' && a.tariffKind === 'DriverTariff');
    steps.push({
      step: 5,
      description: 'GetTariffsResponse with DriverTariff TestSystem1',
      status:
        (res as Record<string, unknown>).status === 'Accepted' && hasDriverTariff
          ? 'passed'
          : 'failed',
      expected: 'status Accepted, tariffKind DriverTariff, tariffId TestSystem1',
      actual: `status: ${String((res as Record<string, unknown>).status)}, hasDriverTariff: ${String(hasDriverTariff)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
