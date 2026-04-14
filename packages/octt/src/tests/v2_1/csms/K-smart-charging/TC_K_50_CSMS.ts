// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_50_CSMS: EMS Control - Reset / release external charging limit - Without ongoing transaction
 * Use case: K13
 */
export const TC_K_50_CSMS: TestCase = {
  id: 'TC_K_50_CSMS',
  name: 'EMS Control - Reset / release external charging limit - Without ongoing transaction',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'A charging limit can be removed by an external system on the Charging Station without a transaction.',
  purpose: 'To verify if the CSMS is able to receive the notify and respond correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    const res = await ctx.client.sendCall('ClearedChargingLimit', {
      chargingLimitSource: 'EMS',
    });

    steps.push({
      step: 1,
      description: 'Send ClearedChargingLimitRequest with chargingLimitSource EMS',
      status: 'passed',
      expected: 'ClearedChargingLimitResponse received',
      actual: `Response keys: ${Object.keys(res).join(', ') || 'empty (accepted)'}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_51_CSMS: EMS Control - Reset / release external charging limit - With ongoing transaction
 * Use case: K13
 * Before: State is EnergyTransferStarted
 */
export const TC_K_51_CSMS: TestCase = {
  id: 'TC_K_51_CSMS',
  name: 'EMS Control - Reset / release external charging limit - With ongoing transaction',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'A charging limit can be removed by an external system on the Charging Station during a transaction.',
  purpose:
    'To verify if the CSMS is able to receive the notify and respond correctly during a transaction.',
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

    // Step 1-2: ClearedChargingLimit
    const clearRes = await ctx.client.sendCall('ClearedChargingLimit', {
      chargingLimitSource: 'EMS',
    });

    steps.push({
      step: 1,
      description: 'Send ClearedChargingLimitRequest with chargingLimitSource EMS',
      status: 'passed',
      expected: 'ClearedChargingLimitResponse received',
      actual: `Response keys: ${Object.keys(clearRes).join(', ') || 'empty (accepted)'}`,
    });

    // Step 3-4: TransactionEvent Updated with ChargingRateChanged
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingRateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated with ChargingRateChanged',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
