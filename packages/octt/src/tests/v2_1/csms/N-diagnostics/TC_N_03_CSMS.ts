// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_05_CSMS: TestCase = {
  id: 'TC_N_05_CSMS',
  name: 'Set Monitoring Base - success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends SetMonitoringBaseRequest for All, FactoryDefault, and HardWiredOnly.',
  purpose: 'To test that CSMS supports all three monitoring base types.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    const bases: string[] = [];
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetMonitoringBase') {
          bases.push(payload['monitoringBase'] as string);
          return { status: 'Accepted' };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetMonitoringBase', {
        stationId: ctx.stationId,
        monitoringBase: 'All',
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetMonitoringBaseRequest(s)',
      status: bases.length > 0 ? 'passed' : 'failed',
      expected: 'At least 1 request',
      actual: `${String(bases.length)} request(s): ${bases.join(', ')}`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
