// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_107_CSMS: TestCase = {
  id: 'TC_N_107_CSMS',
  name: 'Get Periodic Event Streams - Goodflow',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS requests a list of existing periodic event streams.',
  purpose: 'To verify the CSMS can retrieve a list of periodic event streams.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetPeriodicEventStream') {
        received = true;
        return {
          constantStreamData: [
            { id: 2, variableMonitoringId: 3, params: { interval: 10, values: 30 } },
            { id: 3, variableMonitoringId: 4, params: { interval: 10, values: 30 } },
          ],
        };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetPeriodicEventStream', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetPeriodicEventStreamRequest',
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
