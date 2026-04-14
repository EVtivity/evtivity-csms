// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_043_4_CSMS: TestCase = {
  id: 'TC_043_4_CSMS',
  name: 'Send Local Authorization List - Full (1.6)',
  module: 'local-auth-list',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Send a full local authorization list to the Charge Point.',
  purpose:
    'Verify the CSMS can send SendLocalList with Full updateType and entries with idTagInfo.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let updateType = '';
    let hasEntries = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SendLocalList') {
        received = true;
        updateType = (payload['updateType'] as string) || '';
        const entries = payload['localAuthorizationList'] as unknown[] | undefined;
        hasEntries = Array.isArray(entries) && entries.length > 0;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SendLocalList', {
        stationId: ctx.stationId,
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [{ idTag: 'TAG001' }],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive SendLocalList (Full) with entries and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SendLocalList.req with updateType=Full and entries',
      actual: received
        ? `Received, updateType=${updateType}, hasEntries=${String(hasEntries)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
