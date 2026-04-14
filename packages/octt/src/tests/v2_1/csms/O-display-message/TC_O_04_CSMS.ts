// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeGetSpecificDisplayTest = (
  id: string,
  name: string,
  desc: string,
  respondStatus: string,
): TestCase => ({
  id,
  name,
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS can request specific display messages.',
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
    if (received && respondStatus === 'Accepted') {
      try {
        await ctx.client.sendCall('NotifyDisplayMessages', {
          requestId: 1,
          messageInfo: [
            {
              id: 1,
              priority: 'NormalCycle',
              state: 'Idle',
              message: { format: 'UTF8', content: 'Test message' },
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

export const TC_O_07_CSMS = makeGetSpecificDisplayTest(
  'TC_O_07_CSMS',
  'Get a Specific Display Message - Id',
  'Request specific message by ID.',
  'Accepted',
);
export const TC_O_08_CSMS = makeGetSpecificDisplayTest(
  'TC_O_08_CSMS',
  'Get a Specific Display Message - Priority',
  'Request messages by priority.',
  'Accepted',
);
export const TC_O_09_CSMS = makeGetSpecificDisplayTest(
  'TC_O_09_CSMS',
  'Get a Specific Display Message - State',
  'Request messages by state.',
  'Accepted',
);
export const TC_O_11_CSMS = makeGetSpecificDisplayTest(
  'TC_O_11_CSMS',
  'Get a Specific Display Message - Unknown parameters',
  'Request message with unknown ID.',
  'Unknown',
);
