// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeSetDisplayTest = (
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
  purpose: 'To verify the CSMS sends SetDisplayMessageRequest correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetDisplayMessage') {
        received = true;
        return { status: respondStatus };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDisplayMessage', {
        stationId: ctx.stationId,
        message: {
          id: 1,
          priority: 'NormalCycle',
          state: 'Charging',
          message: { format: 'UTF8', content: 'Test message' },
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: `CSMS sends SetDisplayMessageRequest`,
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: `Respond with status ${respondStatus}`,
      status: received ? 'passed' : 'failed',
      expected: `Response ${respondStatus}`,
      actual: received ? respondStatus : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_O_01_CSMS = makeSetDisplayTest(
  'TC_O_01_CSMS',
  'Set Display Message - Success',
  'CSMS sends SetDisplayMessageRequest.',
  'Accepted',
);
export const TC_O_13_CSMS = makeSetDisplayTest(
  'TC_O_13_CSMS',
  'Set Display Message - Display message at StartTime',
  'CSMS sends SetDisplayMessageRequest with startTime.',
  'Accepted',
);
export const TC_O_14_CSMS = makeSetDisplayTest(
  'TC_O_14_CSMS',
  'Set Display Message - Remove message after EndTime',
  'CSMS sends SetDisplayMessageRequest with endTime.',
  'Accepted',
);
export const TC_O_17_CSMS = makeSetDisplayTest(
  'TC_O_17_CSMS',
  'Set Display Message - NotSupportedPriority',
  'CS responds NotSupportedPriority.',
  'NotSupportedPriority',
);
export const TC_O_18_CSMS = makeSetDisplayTest(
  'TC_O_18_CSMS',
  'Set Display Message - NotSupportedState',
  'CS responds NotSupportedState.',
  'NotSupportedState',
);
export const TC_O_19_CSMS = makeSetDisplayTest(
  'TC_O_19_CSMS',
  'Set Display Message - NotSupportedMessageFormat',
  'CS responds NotSupportedMessageFormat.',
  'NotSupportedMessageFormat',
);
export const TC_O_25_CSMS = makeSetDisplayTest(
  'TC_O_25_CSMS',
  'Set Display Message - Send Specific state',
  'CSMS sends SetDisplayMessageRequest with Charging state.',
  'Accepted',
);
export const TC_O_26_CSMS = makeSetDisplayTest(
  'TC_O_26_CSMS',
  'Set Display Message - Rejected',
  'CS responds Rejected.',
  'Rejected',
);
export const TC_O_100_CSMS = makeSetDisplayTest(
  'TC_O_100_CSMS',
  'Set Display Message - unsupported language',
  'CS responds LanguageNotSupported.',
  'LanguageNotSupported',
);
export const TC_O_101_CSMS = makeSetDisplayTest(
  'TC_O_101_CSMS',
  'Set DisplayMessage - Language preference of EV Driver',
  'CSMS sends SetDisplayMessageRequest with language.',
  'Accepted',
);
