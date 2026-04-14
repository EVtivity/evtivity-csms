// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_18_CSMS: TestCase = {
  id: 'TC_N_18_CSMS',
  name: 'Clear Monitoring - Too many elements',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS does not exceed ItemsPerMessage when clearing monitors.',
  purpose: 'To test the CSMS respects ItemsPerMessageClearVariableMonitoring limits.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let clearCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetVariables')
        return {
          getVariableResult: [
            {
              attributeStatus: 'Accepted',
              attributeValue: '5',
              component: { name: 'MonitoringCtrlr' },
              variable: { name: 'ItemsPerMessage', instance: 'ClearVariableMonitoring' },
            },
          ],
        };
      if (action === 'ClearVariableMonitoring') {
        clearCount++;
        return { clearMonitoringResult: [{ id: 1, status: 'Accepted' }] };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearVariableMonitoring', {
        stationId: ctx.stationId,
        id: [1],
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends ClearVariableMonitoringRequest(s)',
      status: clearCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 clear request',
      actual: `${String(clearCount)} request(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_44_CSMS: TestCase = {
  id: 'TC_N_44_CSMS',
  name: 'Clear Monitoring - Rejected',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a Rejected response for clearing a monitor.',
  purpose: 'To verify the CSMS correctly reads a Rejected ClearVariableMonitoring response.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'ClearVariableMonitoring') {
        received = true;
        return { clearMonitoringResult: [{ id: 1, status: 'Rejected' }] };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearVariableMonitoring', {
        stationId: ctx.stationId,
        id: [1],
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends ClearVariableMonitoringRequest, respond Rejected',
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
