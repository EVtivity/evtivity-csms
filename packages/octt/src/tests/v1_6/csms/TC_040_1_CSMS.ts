// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_040_1_CSMS: TestCase = {
  id: 'TC_040_1_CSMS',
  name: 'Configuration Keys - NotSupported (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reject an unknown configuration key with NotSupported.',
  purpose: 'Verify the CSMS handles NotSupported response to ChangeConfiguration.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let changeConfigReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ChangeConfiguration') {
        changeConfigReceived = true;
        return { status: 'NotSupported' };
      }
      return {};
    });

    // Trigger the CSMS to send ChangeConfiguration with an unknown key
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeConfiguration', {
        stationId: ctx.stationId,
        key: 'UnknownConfigKey_OCTT_Test',
        value: 'test',
      });
    }

    // Wait for the command to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 1,
      description: 'Receive ChangeConfiguration from CSMS and respond NotSupported',
      status: changeConfigReceived ? 'passed' : 'failed',
      expected: 'ChangeConfiguration.req received',
      actual: changeConfigReceived ? 'Received, responded NotSupported' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
