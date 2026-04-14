// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_012_CSMS: TestCase = {
  id: 'TC_012_CSMS',
  name: 'Remote Stop Charging Session (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Remotely stop a transaction.',
  purpose: 'Verify the CSMS can send RemoteStopTransaction and the station stops the session.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Set up a charging session
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    await ctx.client.sendCall('Authorize', { idTag });
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const transactionId = startResp['transactionId'] as number;
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    // Handle RemoteStopTransaction from CSMS
    let remoteStopReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'RemoteStopTransaction') {
        remoteStopReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    await new Promise((resolve) => setTimeout(resolve, 5000));

    steps.push({
      step: 1,
      description: 'Receive RemoteStopTransaction from CSMS and respond Accepted',
      status: remoteStopReceived ? 'passed' : 'failed',
      expected: 'RemoteStopTransaction.req received',
      actual: remoteStopReceived ? 'Received, responded Accepted' : 'Not received',
    });

    // Step 2: StopTransaction with reason Remote
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 5000,
      timestamp: new Date().toISOString(),
      reason: 'Remote',
    });
    steps.push({
      step: 2,
      description: 'Send StopTransaction (reason: Remote)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // Step 3: StatusNotification Finishing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Finishing)',
      status: 'passed',
      expected: 'StatusNotification.conf received',
      actual: 'Response received',
    });

    // Step 4: StatusNotification Available
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Available)',
      status: 'passed',
      expected: 'StatusNotification.conf received',
      actual: 'Response received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
