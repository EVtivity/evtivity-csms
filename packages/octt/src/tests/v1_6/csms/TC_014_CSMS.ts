// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_014_CSMS: TestCase = {
  id: 'TC_014_CSMS',
  name: 'Soft Reset (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Soft reset a Charge Point.',
  purpose: 'Verify the CSMS can trigger a soft reset and accept the subsequent boot sequence.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let resetReceived = false;
    let resetType = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'Reset') {
        resetReceived = true;
        resetType = (payload['type'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'Reset', { stationId: ctx.stationId, type: 'Soft' });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive Reset (Soft) from CSMS and respond Accepted',
      status: resetReceived && resetType === 'Soft' ? 'passed' : 'failed',
      expected: 'Reset.req with type=Soft',
      actual: resetReceived ? `Reset received, type=${resetType}` : 'Not received',
    });

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    const bootStatus = bootResp['status'] as string;
    steps.push({
      step: 2,
      description: 'Send BootNotification after reset and expect Accepted',
      status: bootStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootStatus}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Available) for connectors',
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
