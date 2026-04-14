// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_073_CSMS: TestCase = {
  id: 'TC_073_CSMS',
  name: 'Update Charge Point Password for HTTP Basic Authentication (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System configures a new password for HTTP Basic Authentication.',
  purpose: 'Verify the CSMS can send ChangeConfiguration for AuthorizationKey.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let configKey = '';
    let configValue = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ChangeConfiguration') {
        received = true;
        configKey = (payload['key'] as string) || '';
        configValue = (payload['value'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeConfiguration', {
        stationId: ctx.stationId,
        key: 'AuthorizationKey',
        value: 'newpassword123456',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ChangeConfiguration for AuthorizationKey and respond Accepted',
      status: received && configKey === 'AuthorizationKey' ? 'passed' : 'failed',
      expected: 'ChangeConfiguration.req with key=AuthorizationKey',
      actual: received
        ? `Received, key=${configKey}, value length=${String(configValue.length)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
