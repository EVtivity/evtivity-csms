// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeGetDisplayTest = (
  id: string,
  name: string,
  desc: string,
  respondStatus: string,
  hasNotify: boolean,
): TestCase => ({
  id,
  name,
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS sends GetDisplayMessagesRequest correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetDisplayMessages') {
        received = true;
        return { status: respondStatus };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetDisplayMessages', {
        stationId: ctx.stationId,
        requestId: 1,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetDisplayMessagesRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    if (received && hasNotify) {
      try {
        await ctx.client.sendCall('NotifyDisplayMessages', {
          requestId: 1,
          messageInfo: [
            {
              id: 1,
              priority: 'NormalCycle',
              state: 'Idle',
              message: { format: 'UTF8', content: 'Hello' },
            },
          ],
        });
        steps.push({
          step: 2,
          description: 'Send NotifyDisplayMessagesRequest',
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: 2,
          description: 'Send NotifyDisplayMessagesRequest',
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_O_02_CSMS = makeGetDisplayTest(
  'TC_O_02_CSMS',
  'Get all Display Messages - Success',
  'Get all installed display messages.',
  'Accepted',
  true,
);
export const TC_O_03_CSMS = makeGetDisplayTest(
  'TC_O_03_CSMS',
  'Get all Display Messages - No DisplayMessages configured',
  'Get messages when none are configured.',
  'Unknown',
  false,
);
