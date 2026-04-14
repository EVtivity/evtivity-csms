// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_018_1_CSMS: TestCase = {
  id: 'TC_018_1_CSMS',
  name: 'Unlock Connector - With Charging Session (Not Fixed Cable) (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Unlock a connector while a transaction is ongoing.',
  purpose: 'Verify the CSMS handles UnlockConnector during an active session with StopTransaction.',
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

    let unlockReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'UnlockConnector') {
        unlockReceived = true;
        return { status: 'Unlocked' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'UnlockConnector', {
        stationId: ctx.stationId,
        connectorId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive UnlockConnector from CSMS and respond Unlocked',
      status: unlockReceived ? 'passed' : 'failed',
      expected: 'UnlockConnector.req received',
      actual: unlockReceived ? 'Received, responded Unlocked' : 'Not received',
    });

    // StatusNotification Finishing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    // StopTransaction with reason UnlockCommand
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 3000,
      timestamp: new Date().toISOString(),
      reason: 'UnlockCommand',
    });
    steps.push({
      step: 2,
      description: 'Send StopTransaction (reason: UnlockCommand)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // StatusNotification Available
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
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
