// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_021_CSMS: TestCase = {
  id: 'TC_021_CSMS',
  name: 'Change/Set Configuration (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Set the value of a configuration key.',
  purpose: 'Verify the CSMS can send ChangeConfiguration for MeterValueSampleInterval.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let changeConfigReceived = false;
    let configKey = '';
    let configValue = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ChangeConfiguration') {
        changeConfigReceived = true;
        configKey = (payload['key'] as string) || '';
        configValue = (payload['value'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    // Trigger the CSMS to send ChangeConfiguration via the REST API
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeConfiguration', {
        stationId: ctx.stationId,
        key: 'MeterValueSampleInterval',
        value: '60',
      });
    }

    // Wait for the command to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 1,
      description: 'Receive ChangeConfiguration from CSMS and respond Accepted',
      status: changeConfigReceived ? 'passed' : 'failed',
      expected: 'ChangeConfiguration.req with key=MeterValueSampleInterval',
      actual: changeConfigReceived
        ? `Received, key=${configKey}, value=${configValue}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
