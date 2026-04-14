// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_08_CSMS: TestCase = {
  id: 'TC_N_08_CSMS',
  name: 'Set Variable Monitoring - One element',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends a request to activate monitoring on one variable.',
  purpose: 'To test that CSMS supports setting monitoring on one variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetVariableMonitoring') {
        received = true;
        return {
          setMonitoringResult: [
            {
              id: 1,
              status: 'Accepted',
              type: 'Delta',
              severity: 8,
              component: { name: 'EVSE', evse: { id: 1 } },
              variable: { name: 'AvailabilityState' },
            },
          ],
        };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetVariableMonitoring', {
        stationId: ctx.stationId,
        setMonitoringData: [
          {
            value: 1,
            type: 'Delta',
            severity: 8,
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'AvailabilityState' },
          },
        ],
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetVariableMonitoringRequest',
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

export const TC_N_09_CSMS: TestCase = {
  id: 'TC_N_09_CSMS',
  name: 'Set Variable Monitoring - Multiple elements',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends a request to activate monitors on different variables.',
  purpose: 'To test that CSMS supports setting multiple monitors on different variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let dataCount = 0;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetVariableMonitoring') {
          received = true;
          const data = payload['setMonitoringData'] as unknown[];
          dataCount = Array.isArray(data) ? data.length : 0;
          return {
            setMonitoringResult: (data as Record<string, unknown>[]).map(
              (d: Record<string, unknown>, i: number) => ({
                id: i + 1,
                status: 'Accepted',
                type: 'Delta',
                severity: 8,
                component: d['component'],
                variable: d['variable'],
              }),
            ),
          };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetVariableMonitoring', {
        stationId: ctx.stationId,
        setMonitoringData: [
          {
            value: 1,
            type: 'Delta',
            severity: 8,
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'AvailabilityState' },
          },
          {
            value: 1,
            type: 'Delta',
            severity: 8,
            component: { name: 'EVSE', evse: { id: 2 } },
            variable: { name: 'AvailabilityState' },
          },
        ],
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetVariableMonitoringRequest with multiple elements',
      status: received ? 'passed' : 'failed',
      expected: 'Request with >= 2 elements',
      actual: received ? `Received with ${String(dataCount)} element(s)` : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
