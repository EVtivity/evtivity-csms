// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_011_1_CSMS: TestCase = {
  id: 'TC_011_1_CSMS',
  name: 'Remote Start Charging Session - Remote Start First (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Start a transaction remotely before the cable is plugged in.',
  purpose:
    'Verify the CSMS sends RemoteStartTransaction and handles authorization and start in remote-first order.',
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

    // Step 4: StartTransaction (cable now plugged in)
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag: tagToUse,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'Send StartTransaction and expect Accepted',
      status: startTagInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // Step 5: StatusNotification Charging
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Charging)',
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
