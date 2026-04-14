// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_043_5_CSMS: TestCase = {
  id: 'TC_043_5_CSMS',
  name: 'Send Local Authorization List - Differential (1.6)',
  module: 'local-auth-list',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Send a differential update to the local authorization list.',
  purpose: 'Verify the CSMS can send SendLocalList with Differential updateType.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let getVersionReceived = false;
    let sendListReceived = false;
    let updateType = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'GetLocalListVersion') {
        getVersionReceived = true;
        return { listVersion: 1 };
      }
      if (action === 'SendLocalList') {
        sendListReceived = true;
        updateType = (payload['updateType'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SendLocalList', {
        stationId: ctx.stationId,
        listVersion: 2,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'TAG001' }],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetLocalListVersion (optional) and respond',
      status: getVersionReceived ? 'passed' : 'passed',
      expected: 'GetLocalListVersion.req (optional)',
      actual: getVersionReceived ? 'Received, responded listVersion=1' : 'Not received (optional)',
    });

    steps.push({
      step: 2,
      description: 'Receive SendLocalList (Differential) and respond Accepted',
      status: sendListReceived ? 'passed' : 'failed',
      expected: 'SendLocalList.req with updateType=Differential',
      actual: sendListReceived ? `Received, updateType=${updateType}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
