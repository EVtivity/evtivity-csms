// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_030_CSMS: TestCase = {
  id: 'TC_030_CSMS',
  name: 'Unlock Connector - Unlock Failure (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Report a connector unlock failure.',
  purpose: 'Verify the CSMS handles UnlockFailed response to UnlockConnector.',
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
        return { status: 'UnlockFailed' };
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
      description: 'Receive UnlockConnector from CSMS and respond UnlockFailed',
      status: unlockReceived ? 'passed' : 'failed',
      expected: 'UnlockConnector.req received',
      actual: unlockReceived ? 'Received, responded UnlockFailed' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
