// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_J_01_CSMS: Clock-aligned Meter Values - No transaction ongoing
 * Use case: J01 (J01.FR.18)
 * Scenario:
 *   1. Send MeterValuesRequest with clock-aligned context
 *   2. CSMS responds accordingly
 *   Repeated 3 times
 */
export const TC_J_01_CSMS: TestCase = {
  id: 'TC_J_01_CSMS',
  name: 'Clock-aligned Meter Values - No transaction ongoing',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter or other sensor/transducer hardware to provide clock-aligned meter values.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending clock-aligned Meter Values, when there is no transaction ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Send 3 clock-aligned MeterValues (no transaction)
    for (let i = 0; i < 3; i++) {
      try {
        await ctx.client.sendCall('MeterValues', {
          evseId: 1,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: (i + 1) * 500,
                  context: 'Sample.Clock',
                  measurand: 'Energy.Active.Import.Register',
                },
              ],
            },
          ],
        });

        steps.push({
          step: i + 1,
          description: `MeterValues clock-aligned #${String(i + 1)} accepted`,
          status: 'passed',
          expected: 'MeterValuesResponse received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 1,
          description: `MeterValues clock-aligned #${String(i + 1)}`,
          status: 'failed',
          expected: 'MeterValuesResponse received',
          actual: 'Error or rejection',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_J_02_CSMS: Clock-aligned Meter Values - Transaction ongoing
 * Use case: J01 (J01.FR.18)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1-2. MeterValues for idle EVSEs
 *   3-4. TransactionEvent Updated with MeterValueClock
 */
export const TC_J_02_CSMS: TestCase = {
  id: 'TC_J_02_CSMS',
  name: 'Clock-aligned Meter Values - Transaction ongoing',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter or other sensor/transducer hardware to provide clock-aligned meter values.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending clock-aligned Meter Values, when there is a transaction ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Start transaction
    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // Step 1-2: MeterValues for evseId=0 (station-level, idle EVSE)
    try {
      await ctx.client.sendCall('MeterValues', {
        evseId: 0,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 100,
                context: 'Sample.Clock',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });
      steps.push({
        step: 1,
        description: 'MeterValues clock-aligned for evseId=0',
        status: 'passed',
        expected: 'MeterValuesResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'MeterValues clock-aligned for evseId=0',
        status: 'failed',
        expected: 'MeterValuesResponse received',
        actual: 'Error or rejection',
      });
    }

    // Step 3-4: TransactionEvent Updated with MeterValueClock
    for (let i = 0; i < 2; i++) {
      try {
        const res = await ctx.client.sendCall('TransactionEvent', {
          eventType: 'Updated',
          timestamp: new Date().toISOString(),
          triggerReason: 'MeterValueClock',
          seqNo: i + 1,
          transactionInfo: { transactionId: txId, chargingState: 'Charging' },
          evse: { id: 1, connectorId: 1 },
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: (i + 1) * 1000,
                  context: 'Sample.Clock',
                  measurand: 'Energy.Active.Import.Register',
                },
              ],
            },
          ],
        });
        steps.push({
          step: i + 2,
          description: `TransactionEvent Updated MeterValueClock #${String(i + 1)}`,
          status: 'passed',
          expected: 'TransactionEventResponse received',
          actual: `Response keys: ${Object.keys(res).join(', ')}`,
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `TransactionEvent Updated MeterValueClock #${String(i + 1)}`,
          status: 'failed',
          expected: 'TransactionEventResponse received',
          actual: 'Error or rejection',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_J_03_CSMS: Clock-aligned Meter Values - EventType Ended
 * Use case: J01 (J01.FR.18)
 * Before: State is EnergyTransferStarted
 * Scenario: EVDisconnected with clock-aligned meter values and Transaction.End context
 */
export const TC_J_03_CSMS: TestCase = {
  id: 'TC_J_03_CSMS',
  name: 'Clock-aligned Meter Values - EventType Ended',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter or other sensor/transducer hardware to provide clock-aligned meter values.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending clock-aligned Meter Values, when a transaction ends.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // End transaction with clock-aligned meter values
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: 5000, context: 'Sample.Clock', measurand: 'Energy.Active.Import.Register' },
          ],
        },
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: 5000, context: 'Transaction.End', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with clock-aligned and Transaction.End meter values',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_J_04_CSMS: Clock-aligned Meter Values - Signed
 * Use case: J01 (J01.FR.21)
 * Before: State is EnergyTransferStarted
 * Scenario: EVDisconnected with signed meter values
 */
export const TC_J_04_CSMS: TestCase = {
  id: 'TC_J_04_CSMS',
  name: 'Clock-aligned Meter Values - Signed',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter or other sensor/transducer hardware to provide clock-aligned signed meter values.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending clock-aligned Meter Values with signed values.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 5000,
              context: 'Sample.Clock',
              measurand: 'Energy.Active.Import.Register',
              signedMeterValue: {
                signedMeterData: 'OCTT-SIGNED-DATA',
                signingMethod: 'OCTT-METHOD',
                encodingMethod: 'OCTT-ENCODING',
                publicKey: 'OCTT-PUBLIC-KEY',
              },
            },
          ],
        },
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 5000,
              context: 'Transaction.End',
              measurand: 'Energy.Active.Import.Register',
              signedMeterValue: {
                signedMeterData: 'OCTT-SIGNED-DATA-END',
                signingMethod: 'OCTT-METHOD',
                encodingMethod: 'OCTT-ENCODING',
                publicKey: 'OCTT-PUBLIC-KEY',
              },
            },
          ],
        },
      ],
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Ended with signed clock-aligned meter values',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
