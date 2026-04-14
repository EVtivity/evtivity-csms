// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_017_2_CSMS: TestCase = {
  id: 'TC_017_2_CSMS',
  name: 'Unlock Connector - No Charging Session (Fixed Cable) (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Unlock a connector with a fixed cable (not supported).',
  purpose: 'Verify the CSMS handles NotSupported response for UnlockConnector on fixed cables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let unlockReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'UnlockConnector') {
        unlockReceived = true;
        return { status: 'NotSupported' };
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
      description: 'Receive UnlockConnector from CSMS and respond NotSupported',
      status: unlockReceived ? 'passed' : 'failed',
      expected: 'UnlockConnector.req received',
      actual: unlockReceived ? 'Received, responded NotSupported' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
