// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_011_2_CSMS: TestCase = {
  id: 'TC_011_2_CSMS',
  name: 'Remote Start Charging Session - Time Out (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'Connector returns to Available after RemoteStartTransaction when connection timeout is reached.',
  purpose: 'Verify the CSMS handles timeout after remote start with no cable plugged in.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let remoteStartReceived = false;
    let remoteStartIdTag = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'RemoteStartTransaction') {
        remoteStartReceived = true;
        remoteStartIdTag = (payload['idTag'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'RemoteStartTransaction', {
        stationId: ctx.stationId,
        idTag: 'OCTT-TOKEN-001',
        connectorId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive RemoteStartTransaction from CSMS and respond Accepted',
      status: remoteStartReceived ? 'passed' : 'failed',
      expected: 'RemoteStartTransaction.req received',
      actual: remoteStartReceived ? 'Received, responded Accepted' : 'Not received',
    });

    const tagToUse = remoteStartIdTag || idTag;

    // Step 2: Authorize
    const authResp = await ctx.client.sendCall('Authorize', { idTag: tagToUse });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'Send Authorize and expect Accepted',
      status: authStatus?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(authStatus?.['status'])}`,
    });

    // Step 3: StatusNotification Preparing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    // Step 4: StatusNotification Available (timeout reached, no cable plugged)
    const snResp = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Available after timeout)',
      status: snResp !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
