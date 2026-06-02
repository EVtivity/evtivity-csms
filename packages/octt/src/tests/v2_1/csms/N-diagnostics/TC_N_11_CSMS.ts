// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';

export const TC_N_105_CSMS: TestCase = {
  id: 'TC_N_105_CSMS',
  name: 'Set Variable Monitoring - Frequent Periodic - Periodic',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS accepts and receives periodic event streams.',
  purpose: 'To verify the CSMS can accept and reconfigure periodic event streams.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp1 = await ctx.client.sendCall('OpenPeriodicEventStream', {
        constantStreamData: {
          id: 2,
          variableMonitoringId: 3,
          params: { interval: 10, values: 30 },
        },
      });
      pushSendAckStep(steps, 1, 'Send OpenPeriodicEventStreamRequest', resp1);
    } catch {
      steps.push({
        step: 1,
        description: 'Send OpenPeriodicEventStreamRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    let adjustReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'AdjustPeriodicEventStream') {
        adjustReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'AdjustPeriodicEventStream', {
        stationId: ctx.stationId,
        id: 2,
        params: { interval: 5, values: 15 },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 2,
      description: 'CSMS sends AdjustPeriodicEventStreamRequest',
      status: adjustReceived ? 'passed' : 'failed',
      expected: 'Adjust request received',
      actual: adjustReceived ? 'Received' : 'Not received',
    });
    try {
      const resp3 = await ctx.client.sendCall('ClosePeriodicEventStream', { id: 2 });
      pushSendAckStep(steps, 3, 'Send ClosePeriodicEventStreamRequest', resp3);
    } catch {
      steps.push({
        step: 3,
        description: 'Send ClosePeriodicEventStreamRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
