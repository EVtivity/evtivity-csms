// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_08_CS: CsTestCase = {
  id: 'TC_N_08_CS',
  name: 'Set Variable Monitoring - one element',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends a request to activate a monitor on a single variable.',
  purpose: 'To test that Charging Station supports setting of a monitor on a variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
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
    const results = res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const r = results?.[0];
    steps.push({
      step: 1,
      description: 'SetVariableMonitoring Accepted for EVSE AvailabilityState Delta',
      status:
        (r?.['status'] as string) === 'Accepted' && (r?.['type'] as string) === 'Delta'
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, type = Delta',
      actual: `status = ${r?.['status']}, type = ${r?.['type']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_09_CS: CsTestCase = {
  id: 'TC_N_09_CS',
  name: 'Set Variable Monitoring - Multiple elements',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends a request to activate monitors on different variables.',
  purpose: 'To test that Charging Station supports setting multiple monitors.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
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
          component: { name: 'ChargingStation' },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const results = res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const allAccepted = results?.every((r) => (r['status'] as string) === 'Accepted') ?? false;
    steps.push({
      step: 1,
      description: 'Both monitors Accepted',
      status: allAccepted && (results?.length ?? 0) >= 2 ? 'passed' : 'failed',
      expected: 'All statuses = Accepted',
      actual: `results = ${JSON.stringify(results?.map((r) => r['status']))}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_10_CS: CsTestCase = {
  id: 'TC_N_10_CS',
  name: 'Set Variable Monitoring - Multiple on same component/variable',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sets two monitors on the same component/variable combination.',
  purpose: 'To test that Charging Station supports multiple monitors on same component/variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
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
          severity: 7,
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const results = res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const allAccepted = results?.every((r) => (r['status'] as string) === 'Accepted') ?? false;
    steps.push({
      step: 1,
      description: 'Both monitors Accepted',
      status: allAccepted ? 'passed' : 'failed',
      expected: 'All statuses = Accepted',
      actual: `results = ${JSON.stringify(results?.map((r) => r['status']))}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_11_CS: CsTestCase = {
  id: 'TC_N_11_CS',
  name: 'Set Variable Monitoring - Unknown component',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS tries to set a monitor on unknown components.',
  purpose: 'To test that Charging Station checks whether a component exists.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [
        {
          value: 1,
          type: 'Delta',
          severity: 8,
          component: { name: 'EVSE', evse: { id: 99 } },
          variable: { name: 'AvailabilityState' },
        },
        {
          value: 1234.0,
          type: 'UpperThreshold',
          severity: 8,
          component: { name: 'NonExistent' },
          variable: { name: 'Power' },
        },
      ],
    });
    const results = res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const r0 = results?.[0]?.['status'] as string;
    const r1 = results?.[1]?.['status'] as string;
    steps.push({
      step: 1,
      description: 'UnknownComponent or Rejected for both',
      status:
        ['UnknownComponent', 'Rejected'].includes(r0) &&
        ['UnknownComponent', 'UnknownVariable'].includes(r1)
          ? 'passed'
          : 'failed',
      expected:
        'UnknownComponent/Rejected for EVSE 99, UnknownComponent/UnknownVariable for NonExistent',
      actual: `r0 = ${r0}, r1 = ${r1}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_12_CS: CsTestCase = {
  id: 'TC_N_12_CS',
  name: 'Set Variable Monitoring - Value out of range - Delta',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS tries to set a delta monitor with a negative value.',
  purpose: 'To test that Charging Station checks that value is within range.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [
        {
          value: -1,
          type: 'Delta',
          severity: 8,
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'Power' },
        },
      ],
    });
    const r = (res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined)?.[0];
    steps.push({
      step: 1,
      description: 'Rejected for negative delta value',
      status: (r?.['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${r?.['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_13_CS: CsTestCase = {
  id: 'TC_N_13_CS',
  name: 'Set Variable Monitoring - Value out of range - Threshold',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS tries to set a threshold monitor with a value exceeding max limit.',
  purpose: 'To test that Charging Station checks that value is within range.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [
        {
          value: 999999,
          type: 'UpperThreshold',
          severity: 8,
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'Power' },
        },
      ],
    });
    const r = (res['setMonitoringResult'] as Array<Record<string, unknown>> | undefined)?.[0];
    steps.push({
      step: 1,
      description: 'Rejected for out-of-range threshold value',
      status: (r?.['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${r?.['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
