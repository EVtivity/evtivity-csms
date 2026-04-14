// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeClearDisplayTest = (
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
  purpose: 'To verify the CSMS sends ClearDisplayMessageRequest correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'ClearDisplayMessage') {
        received = true;
        return { status: respondStatus };
      }
      if (action === 'GetDisplayMessages') return { status: 'Accepted' };
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearDisplayMessage', {
        stationId: ctx.stationId,
        id: 1,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends ClearDisplayMessageRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_O_04_CSMS = makeClearDisplayTest(
  'TC_O_04_CSMS',
  'Clear Display Message - Success',
  'Clear a configured display message.',
  'Accepted',
);
export const TC_O_05_CSMS = makeClearDisplayTest(
  'TC_O_05_CSMS',
  'Clear Display Message - Unknown Key',
  'Clear a display message with unknown ID.',
  'Unknown',
);
