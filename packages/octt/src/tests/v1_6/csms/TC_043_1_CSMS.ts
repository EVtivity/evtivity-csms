// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_043_1_CSMS: TestCase = {
  id: 'TC_043_1_CSMS',
  name: 'Send Local Authorization List - NotSupported (1.6)',
  module: 'local-auth-list',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Handle NotSupported response when sending local authorization list.',
  purpose: 'Verify the CSMS handles NotSupported response to SendLocalList.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let updateType = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SendLocalList') {
        received = true;
        updateType = (payload['updateType'] as string) || '';
        return { status: 'NotSupported' };
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
      description: 'Receive SendLocalList (Full) and respond NotSupported',
      status: received ? 'passed' : 'failed',
      expected: 'SendLocalList.req with updateType=Full',
      actual: received
        ? `Received, updateType=${updateType}, responded NotSupported`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
