// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_37_CSMS: TestCase = {
  id: 'TC_C_37_CSMS',
  name: 'Clear Authorization Data in Authorization Cache - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to clear all identifiers from the Authorization Cache.',
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

    // Step 2: The CSMS sends ClearCacheRequest, station responds Accepted
    let clearCacheReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ClearCache') {
        clearCacheReceived = true;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Wait for the CSMS to send ClearCache
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearCache', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    steps.push({
      step: 2,
      description: 'Respond to ClearCacheRequest with status Accepted',
      status: clearCacheReceived ? 'passed' : 'failed',
      expected: 'ClearCache request received from CSMS',
      actual: clearCacheReceived
        ? 'ClearCache received and responded Accepted'
        : 'ClearCache not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
