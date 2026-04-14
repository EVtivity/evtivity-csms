// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_026_CSMS: TestCase = {
  id: 'TC_026_CSMS',
  name: 'Remote Start Charging Session - Rejected (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Charge Point rejects a RemoteStartTransaction request.',
  purpose: 'Verify the CSMS handles a Rejected response to RemoteStartTransaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let remoteStartReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'RemoteStartTransaction') {
        remoteStartReceived = true;
        return { status: 'Rejected' };
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
      description: 'Receive RemoteStartTransaction from CSMS and respond Rejected',
      status: remoteStartReceived ? 'passed' : 'failed',
      expected: 'RemoteStartTransaction.req received',
      actual: remoteStartReceived ? 'Received, responded Rejected' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
