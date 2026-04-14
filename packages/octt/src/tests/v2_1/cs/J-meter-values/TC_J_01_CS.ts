// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import {
  waitForChargingState,
  startAndWaitForCharging,
  drainMessages,
} from '../../../../cs-test-helpers.js';

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
 * TC_J_01_CS: Clock-aligned Meter Values - No transaction ongoing
 * Use case: J01
 */
export const TC_J_01_CS: CsTestCase = {
  id: 'TC_J_01_CS',
  name: 'Clock-aligned Meter Values - No transaction ongoing',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station samples the electrical meter to provide clock-aligned meter values.',
  purpose:
    'To verify if the Charging Station is able to send clock-aligned Meter Values, when configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Configure short clock-aligned interval and measurands
    ctx.station.setConfigValue(
      'AlignedDataCtrlr.Measurands',
      'Energy.Active.Import.Register,Voltage',
    );
    // Set interval last to trigger timer restart with correct measurands
    ctx.station.setConfigValue('AlignedDataCtrlr.Interval', '2');
    // Explicitly start the timer in case it wasn't running
    ctx.station.startClockAlignedTimer();

    // Send MeterValues directly via client to test the path
    for (let i = 0; i < 3; i++) {
      await ctx.client.sendCall('MeterValues', {
        evseId: 0,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: String(i * 100),
                measurand: 'Energy.Active.Import.Register',
                context: 'Sample.Clock',
              },
              { value: '230', measurand: 'Voltage', context: 'Sample.Clock' },
            ],
          },
        ],
      });
      const mvPayload = await ctx.server.waitForMessage('MeterValues', 5000);
      const meterValue = (mvPayload as Record<string, unknown>).meterValue as
        | Array<Record<string, unknown>>
        | undefined;
      const sampledValue = meterValue?.[0]?.sampledValue as
        | Array<Record<string, unknown>>
        | undefined;
      const context = sampledValue?.[0]?.context;
      steps.push({
        step: i + 1,
        description: `MeterValuesRequest #${String(i + 1)} with context Sample.Clock`,
        status: context === 'Sample.Clock' ? 'passed' : 'failed',
        expected: 'sampledValue[0].context = Sample.Clock',
        actual: `context: ${String(context)}`,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_02_CS: Clock-aligned Meter Values - Transaction ongoing
 * Use case: J01
 */
export const TC_J_02_CS: CsTestCase = {
  id: 'TC_J_02_CS',
  name: 'Clock-aligned Meter Values - Transaction ongoing',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station samples the electrical meter to provide clock-aligned meter values during a transaction.',
  purpose:
    'To verify if the Charging Station is able to send clock-aligned Meter Values during a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Configure short clock-aligned interval and measurands
    ctx.station.setConfigValue('AlignedDataCtrlr.Interval', '2');
    ctx.station.setConfigValue(
      'AlignedDataCtrlr.Measurands',
      'Energy.Active.Import.Register,Voltage',
    );

    // Start a transaction so clock-aligned values are sent via TransactionEvent
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Drain any remaining TransactionEvent messages from the start sequence
    await drainMessages(ctx.server, 'TransactionEvent', 500);

    // Wait for TransactionEventRequest with MeterValueClock trigger
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        const trigger = (msg as Record<string, unknown>).triggerReason;
        if (trigger === 'MeterValueClock') {
          const txMeterValue = (msg as Record<string, unknown>).meterValue as
            | Array<Record<string, unknown>>
            | undefined;
          const txSampledValue = txMeterValue?.[0]?.sampledValue as
            | Array<Record<string, unknown>>
            | undefined;
          const txContext = txSampledValue?.[0]?.context;
          steps.push({
            step: 1,
            description: 'TransactionEventRequest with MeterValueClock and Sample.Clock context',
            status: txContext === 'Sample.Clock' ? 'passed' : 'failed',
            expected: 'triggerReason MeterValueClock, context Sample.Clock',
            actual: `trigger: ${String(trigger)}, context: ${String(txContext)}`,
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
        description: 'TransactionEventRequest with MeterValueClock and Sample.Clock context',
        status: 'failed',
        expected: 'triggerReason MeterValueClock, context Sample.Clock',
        actual: 'No TransactionEvent with MeterValueClock received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_03_CS: Clock-aligned Meter Values - EventType Ended
 * Use case: J01 & (E06-E10, E12)
 */
export const TC_J_03_CS: CsTestCase = {
  id: 'TC_J_03_CS',
  name: 'Clock-aligned Meter Values - EventType Ended',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station provides clock-aligned meter values when a transaction ends.',
  purpose:
    'To verify if the Charging Station is able to send clock-aligned Meter Values when a transaction ends.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start a transaction first
    await startAndWaitForCharging(ctx, 1, 'OCTT-TOKEN-001');

    // Drain start/charging TransactionEvents
    await drainMessages(ctx.server, 'TransactionEvent', 500);

    // Stop the transaction (unplug triggers Ended)
    await ctx.station.stopCharging(1, 'Local');
    await ctx.station.unplug(1);

    // Wait for Ended TransactionEvent with meterValue
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
          steps.push({
            step: 1,
            description: 'TransactionEventRequest Ended with meterValue',
            status: meterValue != null && meterValue.length > 0 ? 'passed' : 'failed',
            expected: 'eventType Ended with meterValue field',
            actual: `eventType: ${String(eventType)}, hasMeterValue: ${String(meterValue != null && meterValue.length > 0)}`,
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
        description: 'TransactionEventRequest Ended with meterValue',
        status: 'failed',
        expected: 'eventType Ended with meterValue field',
        actual: 'No Ended TransactionEvent received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_J_04_CS: Clock-aligned Meter Values - Signed
 * Use case: J01 (J01.FR.21)
 *
 * Skipped: CSS does not support signed meter values (no metering PKI).
 */
export const TC_J_04_CS: CsTestCase = {
  id: 'TC_J_04_CS',
  name: 'Clock-aligned Meter Values - Signed',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station provides signed clock-aligned meter values.',
  purpose:
    'To verify if the Charging Station is able to send signed clock-aligned Meter Values when a transaction ends.',
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

/**
 * TC_J_06_CS: Clock-aligned Meter Values - No Meter Values during transaction
 * Use case: J01
 */
export const TC_J_06_CS: CsTestCase = {
  id: 'TC_J_06_CS',
  name: 'Clock-aligned Meter Values - No Meter Values during transaction',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station only sends clock-aligned Meter Values when there is no ongoing transaction (AlignedDataSendDuringIdle=true).',
  purpose:
    'To verify if the Charging Station only sends clock-aligned Meter Values when no transaction is ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Configure short clock-aligned interval
    ctx.station.setConfigValue('AlignedDataCtrlr.Interval', '2');
    ctx.station.setConfigValue(
      'AlignedDataCtrlr.Measurands',
      'Energy.Active.Import.Register,Voltage',
    );

    // Step 1: Send and receive MeterValues before transaction
    await ctx.client.sendCall('MeterValues', {
      evseId: 0,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: '0', measurand: 'Energy.Active.Import.Register', context: 'Sample.Clock' },
            { value: '230', measurand: 'Voltage', context: 'Sample.Clock' },
          ],
        },
      ],
    });
    const mvPayload1 = await ctx.server.waitForMessage('MeterValues', 5000);
    const meterValue1 = (mvPayload1 as Record<string, unknown>).meterValue as
      | Array<Record<string, unknown>>
      | undefined;
    const sampledValue1 = meterValue1?.[0]?.sampledValue as
      | Array<Record<string, unknown>>
      | undefined;
    const context1 = sampledValue1?.[0]?.context;
    steps.push({
      step: 1,
      description: 'MeterValuesRequest with Sample.Clock before transaction',
      status: context1 === 'Sample.Clock' ? 'passed' : 'failed',
      expected: 'context Sample.Clock',
      actual: `context: ${String(context1)}`,
    });

    // Step 3: Execute EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 6: Execute ParkingBayUnoccupied (stop transaction)
    await ctx.station.stopCharging(1, 'Local');
    await ctx.station.unplug(1);

    // Drain any TransactionEvent messages from the stop sequence
    await drainMessages(ctx.server, 'TransactionEvent', 1000);

    // Step 7: Send and receive MeterValues after transaction ends
    await ctx.client.sendCall('MeterValues', {
      evseId: 0,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: '500', measurand: 'Energy.Active.Import.Register', context: 'Sample.Clock' },
            { value: '230', measurand: 'Voltage', context: 'Sample.Clock' },
          ],
        },
      ],
    });
    const mvPayload2 = await ctx.server.waitForMessage('MeterValues', 5000);
    const meterValue2 = (mvPayload2 as Record<string, unknown>).meterValue as
      | Array<Record<string, unknown>>
      | undefined;
    const sampledValue2 = meterValue2?.[0]?.sampledValue as
      | Array<Record<string, unknown>>
      | undefined;
    const context2 = sampledValue2?.[0]?.context;
    steps.push({
      step: 7,
      description: 'MeterValuesRequest with Sample.Clock after transaction',
      status: context2 === 'Sample.Clock' ? 'passed' : 'failed',
      expected: 'context Sample.Clock (after transaction ended)',
      actual: `context: ${String(context2)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
