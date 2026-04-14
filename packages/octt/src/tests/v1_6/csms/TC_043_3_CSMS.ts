// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_043_3_CSMS: TestCase = {
  id: 'TC_043_3_CSMS',
  name: 'Send Local Authorization List - Failed (1.6)',
  module: 'local-auth-list',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Handle Failed response when sending local authorization list.',
  purpose: 'Verify the CSMS handles Failed response to SendLocalList.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'SendLocalList') {
        received = true;
        return { status: 'Failed' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SendLocalList', {
        stationId: ctx.stationId,
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [{ idTag: 'TAG001' }],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive SendLocalList (Full) and respond Failed',
      status: received ? 'passed' : 'failed',
      expected: 'SendLocalList.req received',
      actual: received ? 'Received, responded Failed' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
