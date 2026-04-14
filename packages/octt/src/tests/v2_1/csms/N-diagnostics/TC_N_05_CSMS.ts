// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_16_CSMS: TestCase = {
  id: 'TC_N_16_CSMS',
  name: 'Set Monitoring Level - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sets a monitoring level.',
  purpose: 'To test that CSMS supports setting a monitoring level.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let severity = -1;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetMonitoringLevel') {
          received = true;
          severity = (payload['severity'] as number) ?? -1;
          return { status: 'Accepted' };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetMonitoringLevel', {
        stationId: ctx.stationId,
        severity: 5,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetMonitoringLevelRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received with severity',
      actual: received ? `Received (severity: ${String(severity)})` : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_17_CSMS: TestCase = {
  id: 'TC_N_17_CSMS',
  name: 'Set Monitoring Level - Out of range',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS handles rejection when setting a monitoring level out of range.',
  purpose: 'To test that CSMS handles Rejected response for SetMonitoringLevel.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetMonitoringLevel') {
        received = true;
        return { status: 'Rejected' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetMonitoringLevel', {
        stationId: ctx.stationId,
        severity: 99,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetMonitoringLevelRequest, respond Rejected',
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
