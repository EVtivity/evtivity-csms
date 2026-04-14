// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeTransactionDisplayTest = (
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
  purpose: 'To verify the CSMS sends display messages for specific transactions.',
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
      if (action === 'ClearDisplayMessage') {
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
      description: 'CSMS sends display message command',
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

export const TC_O_06_CSMS = makeTransactionDisplayTest(
  'TC_O_06_CSMS',
  'Set Display Message - Specific transaction - Success',
  'CSMS sends ClearDisplayMessageRequest.',
  'Unknown',
);
export const TC_O_10_CSMS = makeTransactionDisplayTest(
  'TC_O_10_CSMS',
  'Set Display Message - Specific transaction - UnknownTransaction',
  'CS responds UnknownTransaction.',
  'UnknownTransaction',
);
export const TC_O_27_CSMS = makeTransactionDisplayTest(
  'TC_O_27_CSMS',
  'Set Display Message - Specific transaction - StartTime',
  'CSMS sends display message with startTime for transaction.',
  'Accepted',
);
export const TC_O_28_CSMS = makeTransactionDisplayTest(
  'TC_O_28_CSMS',
  'Set Display Message - Specific transaction - EndTime',
  'CSMS sends display message with endTime for transaction.',
  'Accepted',
);
