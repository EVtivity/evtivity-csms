// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_O_12_CSMS: TestCase = {
  id: 'TC_O_12_CSMS',
  name: 'Set Display Message - Replace DisplayMessage',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS replaces a previously configured display message.',
  purpose: 'To verify the CSMS can replace a display message with the same ID.',
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
        return { status: 'Accepted' };
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
          message: { format: 'UTF8', content: 'Replaced message' },
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetDisplayMessageRequest to replace message',
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
};
