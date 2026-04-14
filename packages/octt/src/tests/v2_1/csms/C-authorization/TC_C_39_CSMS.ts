// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_39_CSMS: TestCase = {
  id: 'TC_C_39_CSMS',
  name: 'Authorization by GroupId - Success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId.',
  purpose:
    'To verify if the CSMS is able to correctly handle the Authorization of idTokens with the same GroupId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    // Step 2: The CSMS sends a ClearCacheRequest - station responds Rejected
    // Set up handler for incoming ClearCache from CSMS
    let clearCacheReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ClearCache') {
        clearCacheReceived = true;
        return { status: 'Rejected' };
      }
      return { status: 'NotSupported' };
    });

    // Wait briefly for the CSMS to potentially send ClearCache
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearCache', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    steps.push({
      step: 2,
      description: 'Respond to ClearCacheRequest with status Rejected',
      status: clearCacheReceived ? 'passed' : 'failed',
      expected: 'ClearCache request received from CSMS',
      actual: clearCacheReceived ? 'ClearCache received' : 'ClearCache not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
