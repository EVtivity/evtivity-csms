// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_040_2_CSMS: TestCase = {
  id: 'TC_040_2_CSMS',
  name: 'Configuration Keys - Invalid Value (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reject setting a configuration key when an incorrect value is given.',
  purpose: 'Verify the CSMS handles Rejected response to ChangeConfiguration.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let changeConfigReceived = false;
    let configKey = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ChangeConfiguration') {
        changeConfigReceived = true;
        configKey = (payload['key'] as string) || '';
        return { status: 'Rejected' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeConfiguration', {
        stationId: ctx.stationId,
        key: 'MeterValueSampleInterval',
        value: 'not-a-number',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ChangeConfiguration from CSMS and respond Rejected',
      status: changeConfigReceived ? 'passed' : 'failed',
      expected: 'ChangeConfiguration.req received for MeterValueSampleInterval',
      actual: changeConfigReceived
        ? `Received, key=${configKey}, responded Rejected`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
