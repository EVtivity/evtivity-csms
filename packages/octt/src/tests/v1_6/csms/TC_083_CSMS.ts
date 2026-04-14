// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_083_CSMS: TestCase = {
  id: 'TC_083_CSMS',
  name: 'Upgrade Charge Point Security Profile - Accepted (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System upgrades the Charge Point to a higher security profile.',
  purpose:
    'Verify the CSMS can send ChangeConfiguration for SecurityProfile and trigger a Hard Reset.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let changeConfigReceived = false;
    let resetReceived = false;
    let configKey = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ChangeConfiguration') {
        const key = (payload['key'] as string) || '';
        if (key === 'SecurityProfile') {
          changeConfigReceived = true;
          configKey = key;
        }
        return { status: 'Accepted' };
      }
      if (action === 'Reset') {
        resetReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeConfiguration', {
        stationId: ctx.stationId,
        key: 'SecurityProfile',
        value: '2',
      });
      // Trigger a Hard Reset after ChangeConfiguration
      await ctx.triggerCommand('v16', 'Reset', {
        stationId: ctx.stationId,
        type: 'Hard',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    steps.push({
      step: 1,
      description: 'Receive ChangeConfiguration for SecurityProfile and respond Accepted',
      status: changeConfigReceived && configKey === 'SecurityProfile' ? 'passed' : 'failed',
      expected: 'ChangeConfiguration.req with key=SecurityProfile',
      actual: changeConfigReceived ? `Received, key=${configKey}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Receive Reset (Hard) and respond Accepted',
      status: resetReceived ? 'passed' : 'failed',
      expected: 'Reset.req received',
      actual: resetReceived ? 'Received, responded Accepted' : 'Not received',
    });

    // After reset, reconnect with higher security profile
    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    steps.push({
      step: 3,
      description: 'Send BootNotification after reconnecting with higher security profile',
      status: bootResp['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootResp['status'])}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
