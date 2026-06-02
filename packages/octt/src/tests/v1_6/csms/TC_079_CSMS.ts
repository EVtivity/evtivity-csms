// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import { pushSendAckStep } from '../../../csms-test-helpers.js';

export const TC_079_CSMS: TestCase = {
  id: 'TC_079_CSMS',
  name: 'Get Security Log (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point uploads a security log based on CSMS request.',
  purpose: 'Verify the CSMS can send GetLog for SecurityLog and handle upload notifications.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let logType = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'GetLog') {
        received = true;
        logType = (payload['logType'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'SecurityLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetLog (SecurityLog) and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'GetLog.req with logType=SecurityLog',
      actual: received ? `Received, logType=${logType}` : 'Not received',
    });

    const resp2 = await ctx.client.sendCall('LogStatusNotification', { status: 'Uploading' });
    pushSendAckStep(steps, 2, 'Send LogStatusNotification (Uploading)', resp2);

    const resp3 = await ctx.client.sendCall('LogStatusNotification', { status: 'Uploaded' });
    pushSendAckStep(steps, 3, 'Send LogStatusNotification (Uploaded)', resp3);

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
