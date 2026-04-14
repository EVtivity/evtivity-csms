// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { startAndWaitForCharging, drainMessages } from '../../../../cs-test-helpers.js';

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
    if (action === 'MeterValues') return {};
    return {};
  });
}

/**
 * TC_J_07_CS: Sampled Meter Values - EventType Started - EVSE known
 * Use case: J02 & (E01-E05, E09)
 */
export const TC_J_07_CS: CsTestCase = {
  id: 'TC_J_07_CS',
  name: 'Sampled Meter Values - EventType Started - EVSE known',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station samples the electrical meter to provide sampled meter values when a transaction starts.',
  purpose:
    'To verify if the Charging Station is able to send sampled Meter Values when a transaction starts and the EVSE is known.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging and collect all TransactionEvent messages
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Find the Started TransactionEvent (it should have meterValue with Transaction.Begin)
    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        const eventType = (msg as Record<string, unknown>).eventType;
        if (eventType === 'Started') {
          const meterValue = (msg as Record<string, unknown>).meterValue as
            | Array<Record<string, unknown>>
            | undefined;
          const sampledValue = meterValue?.[0]?.sampledValue as
            | Array<Record<string, unknown>>
            | undefined;
          const context = sampledValue?.[0]?.context;
          steps.push({
            step: 1,
            description: 'TransactionEventRequest Started with Transaction.Begin meter values',
            status:
              meterValue != null && meterValue.length > 0 && context === 'Transaction.Begin'
                ? 'passed'
                : 'failed',
            expected: 'eventType Started, context Transaction.Begin',
            actual: `eventType: ${String(eventType)}, context: ${String(context)}, hasMeterValue: ${String(meterValue != null && meterValue.length > 0)}`,
          });
          found = true;
          break;
        }
      } catch {
        break;
      }
    }

    if (!found) {
      steps.push({
        step: 1,
        description: 'TransactionEventRequest Started with Transaction.Begin meter values',
        status: 'failed',
        expected: 'eventType Started, context Transaction.Begin',
        actual: 'No Started TransactionEvent received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_08_CS: Sampled Meter Values - Context Transaction.Begin - EVSE not known
 * Use case: J02 & (E01-E05, E09)
 */
export const TC_J_08_CS: CsTestCase = {
  id: 'TC_J_08_CS',
  name: 'Sampled Meter Values - Context Transaction.Begin - EVSE not known',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station samples the electrical meter to provide sampled meter values.',
  purpose:
    'To verify if the Charging Station sends Meter Values for Transaction.Begin as soon as the EVSE to be used is known.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Find Started TransactionEvent with evse and Transaction.Begin context
    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        const eventType = (msg as Record<string, unknown>).eventType;
        if (eventType === 'Started') {
          const evse = (msg as Record<string, unknown>).evse as Record<string, unknown> | undefined;
          const meterValue = (msg as Record<string, unknown>).meterValue as
            | Array<Record<string, unknown>>
            | undefined;
          const sampledValue = meterValue?.[0]?.sampledValue as
            | Array<Record<string, unknown>>
            | undefined;
          const context = sampledValue?.[0]?.context;
          steps.push({
            step: 1,
            description: 'First TransactionEventRequest with evse and Transaction.Begin context',
            status: evse != null && context === 'Transaction.Begin' ? 'passed' : 'failed',
            expected: 'evse present, context Transaction.Begin',
            actual: `hasEvse: ${String(evse != null)}, context: ${String(context)}`,
          });
          found = true;
          break;
        }
      } catch {
        break;
      }
    }

    if (!found) {
      steps.push({
        step: 1,
        description: 'First TransactionEventRequest with evse and Transaction.Begin context',
        status: 'failed',
        expected: 'evse present, context Transaction.Begin',
        actual: 'No Started TransactionEvent received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_09_CS: Sampled Meter Values - EventType Updated
 * Use case: J02
 */
export const TC_J_09_CS: CsTestCase = {
  id: 'TC_J_09_CS',
  name: 'Sampled Meter Values - EventType Updated',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station samples the electrical meter to provide sampled meter values during a transaction.',
  purpose:
    'To verify if the Charging Station is able to send sampled Meter Values during the transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Configure short sampled interval so we get periodic updates quickly
    ctx.station.setConfigValue('SampledDataCtrlr.TxUpdatedInterval', '2');

    // Start a transaction
    await startAndWaitForCharging(ctx, 1, 'OCTT-TOKEN-001');

    // Drain the start sequence TransactionEvents
    await drainMessages(ctx.server, 'TransactionEvent', 500);

    // Wait for TransactionEvent Updated with MeterValuePeriodic
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        const trigger = (msg as Record<string, unknown>).triggerReason;
        if (trigger === 'MeterValuePeriodic') {
          const meterValue = (msg as Record<string, unknown>).meterValue as
            | Array<Record<string, unknown>>
            | undefined;
          const sampledValue = meterValue?.[0]?.sampledValue as
            | Array<Record<string, unknown>>
            | undefined;
          const context = sampledValue?.[0]?.context;
          steps.push({
            step: 1,
            description:
              'TransactionEventRequest Updated with MeterValuePeriodic and Sample.Periodic',
            status: context === 'Sample.Periodic' ? 'passed' : 'failed',
            expected: 'triggerReason MeterValuePeriodic, context Sample.Periodic',
            actual: `trigger: ${String(trigger)}, context: ${String(context)}`,
          });
          found = true;
          break;
        }
      } catch {
        break;
      }
    }

    if (!found) {
      steps.push({
        step: 1,
        description: 'TransactionEventRequest Updated with MeterValuePeriodic and Sample.Periodic',
        status: 'failed',
        expected: 'triggerReason MeterValuePeriodic, context Sample.Periodic',
        actual: 'No TransactionEvent with MeterValuePeriodic received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_10_CS: Sampled Meter Values - EventType Ended
 * Use case: J02 & (E06-E10, E12)
 */
export const TC_J_10_CS: CsTestCase = {
  id: 'TC_J_10_CS',
  name: 'Sampled Meter Values - EventType Ended',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station samples the electrical meter to provide sampled meter values when a transaction ends.',
  purpose:
    'To verify if the Charging Station is able to send sampled Meter Values when a transaction ends.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start a transaction
    await startAndWaitForCharging(ctx, 1, 'OCTT-TOKEN-001');

    // Drain start sequence
    await drainMessages(ctx.server, 'TransactionEvent', 500);

    // Stop the transaction
    await ctx.station.stopCharging(1, 'Local');
    await ctx.station.unplug(1);

    // Find the Ended TransactionEvent with meterValue containing Transaction.End
    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        const eventType = (msg as Record<string, unknown>).eventType;
        if (eventType === 'Ended') {
          const meterValue = (msg as Record<string, unknown>).meterValue as
            | Array<Record<string, unknown>>
            | undefined;
          const sampledValues =
            meterValue?.flatMap(
              (mv) => (mv.sampledValue as Array<Record<string, unknown>> | undefined) ?? [],
            ) ?? [];
          const hasTransactionEnd = sampledValues.some((sv) => sv.context === 'Transaction.End');
          steps.push({
            step: 1,
            description: 'TransactionEventRequest Ended with Transaction.End context in meterValue',
            status:
              meterValue != null && meterValue.length > 0 && hasTransactionEnd
                ? 'passed'
                : 'failed',
            expected: 'eventType Ended, context Transaction.End',
            actual: `eventType: ${String(eventType)}, hasMeterValue: ${String(meterValue != null && meterValue.length > 0)}, hasTransactionEnd: ${String(hasTransactionEnd)}`,
          });
          found = true;
          break;
        }
      } catch {
        break;
      }
    }

    if (!found) {
      steps.push({
        step: 1,
        description: 'TransactionEventRequest Ended with Transaction.End context in meterValue',
        status: 'failed',
        expected: 'eventType Ended, context Transaction.End',
        actual: 'No Ended TransactionEvent received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_11_CS: Sampled Meter Values - Signed
 * Use case: J02 (J02.FR.21)
 *
 * Skipped: CSS does not support signed meter values (no metering PKI).
 */
export const TC_J_11_CS: CsTestCase = {
  id: 'TC_J_11_CS',
  name: 'Sampled Meter Values - Signed',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station provides signed sampled meter values when a transaction ends.',
  purpose:
    'To verify if the Charging Station is able to send signed sampled Meter Values when a transaction ends.',
  execute: async () => {
    const steps: StepResult[] = [];
    steps.push({
      step: 1,
      description: 'Signed meter values not supported by CSS (no metering PKI)',
      status: 'skipped',
      expected: 'signedMeterValue present',
      actual: 'Test skipped: CSS does not support signed meter values',
    });
    return { status: 'skipped', durationMs: 0, steps };
  },
};
