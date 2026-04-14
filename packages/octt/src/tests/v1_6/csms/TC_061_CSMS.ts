// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_061_CSMS: TestCase = {
  id: 'TC_061_CSMS',
  name: 'Clear Authorization Data in Authorization Cache (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System clears the authorization cache of a Charge Point.',
  purpose: 'Verify the CSMS can send ClearCache and the Charge Point responds Accepted.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Set up handler for CSMS-initiated ClearCache
    let clearCacheReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ClearCache') {
        clearCacheReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    // Wait for the CSMS to send ClearCache
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ClearCache', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ClearCache from CSMS and respond Accepted',
      status: clearCacheReceived ? 'passed' : 'failed',
      expected: 'ClearCache.req received',
      actual: clearCacheReceived
        ? 'ClearCache received, responded Accepted'
        : 'ClearCache not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
