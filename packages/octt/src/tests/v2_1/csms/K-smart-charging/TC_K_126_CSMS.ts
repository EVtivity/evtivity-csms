// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_126_CSMS: ISO 15118-20 Dynamic Control Mode - Sets no charging profile
 * Use case: K19 (K19.FR.02, K19.FR.04)
 */
export const TC_K_126_CSMS: TestCase = {
  id: 'TC_K_126_CSMS',
  name: 'ISO 15118-20 Dynamic Control Mode - Sets no charging profile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose:
    'To check if the CSMS supports ISO15118-20 Dynamic Control without setting a charging profile.',
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
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        availableEnergyTransfer: [
          'AC_single_phase',
          'AC_two_phase',
          'AC_three_phase',
          'AC_BPT',
          'AC_BPT_DER',
          'AC_DER',
        ],
        controlMode: 'DynamicControl',
        v2xChargingParameters: { maxChargePower: 8000, maxDischargePower: 0 },
      },
    });

    const needsStatus = needsRes['status'] as string;
    steps.push({
      step: 1,
      description: 'Send NotifyEVChargingNeedsRequest with DynamicControl',
      status: needsStatus === 'NoChargingProfile' ? 'passed' : 'failed',
      expected: 'status = NoChargingProfile',
      actual: `status = ${needsStatus}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
