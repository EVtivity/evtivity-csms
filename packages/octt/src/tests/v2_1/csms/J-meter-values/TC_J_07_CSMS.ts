// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_J_07_CSMS: Sampled Meter Values - EventType Started - EVSE known
 * Use case: J02 (J02.FR.19)
 * Scenario: EVConnectedPreSession with Transaction.Begin meter value
 */
export const TC_J_07_CSMS: TestCase = {
  id: 'TC_J_07_CSMS',
  name: 'Sampled Meter Values - EventType Started - EVSE known',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter to provide start sampled Meter Values with EVSE known.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending start sampled Meter Values, when a transaction starts with EVSE known.',
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
    const res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: 0, context: 'Transaction.Begin', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Started with Transaction.Begin meter value (EVSE known)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(res).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_J_08_CSMS: Sampled Meter Values - Context Transaction.Begin - EVSE not known
 * Use case: J02 (J02.FR.19)
 * Scenario: EVConnectedPreSession with Transaction.Begin meter value, no EVSE specified initially
 */
export const TC_J_08_CSMS: TestCase = {
  id: 'TC_J_08_CSMS',
  name: 'Sampled Meter Values - Context Transaction.Begin - EVSE not known',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter to provide start sampled Meter Values with EVSE not known.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending start sampled Meter Values, when a transaction starts with EVSE not known.',
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
    const res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: 0, context: 'Transaction.Begin', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Started with Transaction.Begin meter value (EVSE not known)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(res).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_J_09_CSMS: Sampled Meter Values - EventType Updated
 * Use case: J02 (J02.FR.19)
 * Before: State is EnergyTransferStarted
 * Scenario: TransactionEvent Updated with MeterValuePeriodic x3
 */
export const TC_J_09_CSMS: TestCase = {
  id: 'TC_J_09_CSMS',
  name: 'Sampled Meter Values - EventType Updated',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter to provide sampled Meter Values during a transaction.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending sampled Meter Values, when there is an ongoing transaction.',
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

    for (let i = 0; i < 3; i++) {
      try {
        const res = await ctx.client.sendCall('TransactionEvent', {
          eventType: 'Updated',
          timestamp: new Date().toISOString(),
          triggerReason: 'MeterValuePeriodic',
          seqNo: i + 1,
          transactionInfo: { transactionId: txId, chargingState: 'Charging' },
          evse: { id: 1, connectorId: 1 },
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: (i + 1) * 1000,
                  context: 'Sample.Periodic',
                  measurand: 'Energy.Active.Import.Register',
                },
              ],
            },
          ],
        });
        steps.push({
          step: i + 1,
          description: `TransactionEvent Updated MeterValuePeriodic #${String(i + 1)}`,
          status: 'passed',
          expected: 'TransactionEventResponse received',
          actual: `Response keys: ${Object.keys(res).join(', ')}`,
        });
      } catch {
        steps.push({
          step: i + 1,
          description: `TransactionEvent Updated MeterValuePeriodic #${String(i + 1)}`,
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
 * TC_J_10_CSMS: Sampled Meter Values - EventType Ended
 * Use case: J02 (J02.FR.19)
 * Before: State is EnergyTransferStarted
 * Scenario: EVDisconnected with Sample.Periodic and Transaction.End meter values
 */
export const TC_J_10_CSMS: TestCase = {
  id: 'TC_J_10_CSMS',
  name: 'Sampled Meter Values - EventType Ended',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter to provide sampled Meter Values when a transaction ends.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending sampled Meter Values, when a transaction ends.',
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
            { value: 5000, context: 'Sample.Periodic', measurand: 'Energy.Active.Import.Register' },
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
      description: 'TransactionEvent Ended with sampled and Transaction.End meter values',
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
 * TC_J_11_CSMS: Sampled Meter Values - Signed
 * Use case: J02 (J02.FR.21)
 * Before: State is EnergyTransferStarted
 * Scenario: EVDisconnected with signed sampled meter values
 */
export const TC_J_11_CSMS: TestCase = {
  id: 'TC_J_11_CSMS',
  name: 'Sampled Meter Values - Signed',
  module: 'J-meter-values',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station samples the electrical meter to provide signed sampled Meter Values.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station sending sampled Meter Values with signed values.',
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
              context: 'Sample.Periodic',
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
      description: 'TransactionEvent Ended with signed sampled meter values',
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
