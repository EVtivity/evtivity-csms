// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_042_2_CSMS: TestCase = {
  id: 'TC_042_2_CSMS',
  name: 'Get Local List Version - Empty (1.6)',
  module: 'local-auth-list',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'Retrieve the local authorization list version from a Charge Point with an empty list.',
  purpose: 'Verify the CSMS handles GetLocalListVersion with listVersion 0.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'GetLocalListVersion') {
        received = true;
        return { listVersion: 0 };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'GetLocalListVersion', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetLocalListVersion and respond with listVersion=0',
      status: received ? 'passed' : 'failed',
      expected: 'GetLocalListVersion.req received',
      actual: received ? 'Received, responded listVersion=0' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
