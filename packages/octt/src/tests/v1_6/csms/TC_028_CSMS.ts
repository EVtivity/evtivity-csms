// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_028_CSMS: TestCase = {
  id: 'TC_028_CSMS',
  name: 'Remote Stop Transaction - Rejected (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Charge Point rejects a RemoteStopTransaction request.',
  purpose: 'Verify the CSMS handles a Rejected response to RemoteStopTransaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Start a session first so the CSMS has something to stop
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    await ctx.client.sendCall('Authorize', { idTag });
    await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    let remoteStopReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'RemoteStopTransaction') {
        remoteStopReceived = true;
        return { status: 'Rejected' };
      }
      return {};
    });

    await new Promise((resolve) => setTimeout(resolve, 5000));

    steps.push({
      step: 1,
      description: 'Receive RemoteStopTransaction from CSMS and respond Rejected',
      status: remoteStopReceived ? 'passed' : 'failed',
      expected: 'RemoteStopTransaction.req received',
      actual: remoteStopReceived ? 'Received, responded Rejected' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
