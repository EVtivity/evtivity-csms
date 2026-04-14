// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_S_102_CSMS: TestCase = {
  id: 'TC_S_102_CSMS',
  name: 'Battery Swap - Remote Start - not enough batteries',
  module: 'S-battery-swapping',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS supports battery swapping with not enough batteries.',
  purpose: 'To verify the CSMS handles Rejected response with NoBatteryAvailable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'RequestBatterySwap') {
        received = true;
        return { status: 'Rejected', statusInfo: { reasonCode: 'NoBatteryAvailable' } };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestBatterySwap', {
        stationId: ctx.stationId,
        requestId: 1,
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends RequestBatterySwapRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'Respond with Rejected NoBatteryAvailable',
      status: received ? 'passed' : 'failed',
      expected: 'Response sent',
      actual: received ? 'Sent' : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
