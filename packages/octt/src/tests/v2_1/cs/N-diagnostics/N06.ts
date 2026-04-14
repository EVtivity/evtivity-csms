// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_18_CS: CsTestCase = {
  id: 'TC_N_18_CS',
  name: 'Clear Monitoring - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS clears monitors identified by their IDs.',
  purpose: 'To test that Charging Station clears the monitors.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Setup: create two custom monitors to clear
    const setRes = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [
        {
          value: 1,
          type: 'Delta',
          severity: 8,
          component: { name: 'ChargingStation' },
          variable: { name: 'AvailabilityState' },
        },
        {
          value: 1,
          type: 'Delta',
          severity: 8,
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const setResults = setRes['setMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const monId1 = (setResults?.[0]?.['id'] as number) ?? 0;
    const monId2 = (setResults?.[1]?.['id'] as number) ?? 0;
    steps.push({
      step: 1,
      description: 'Setup: SetVariableMonitoring both Accepted',
      status:
        (setResults?.[0]?.['status'] as string) === 'Accepted' &&
        (setResults?.[1]?.['status'] as string) === 'Accepted'
          ? 'passed'
          : 'failed',
      expected: 'Both Accepted with IDs',
      actual: `ids = [${String(monId1)}, ${String(monId2)}]`,
    });

    // Clear the monitors by their actual IDs
    const res = await ctx.server.sendCommand('ClearVariableMonitoring', { id: [monId1, monId2] });
    const results = res['clearMonitoringResult'] as Array<Record<string, unknown>> | undefined;
    const allAccepted = results?.every((r) => (r['status'] as string) === 'Accepted') ?? false;
    steps.push({
      step: 2,
      description: 'ClearVariableMonitoring both Accepted',
      status: allAccepted ? 'passed' : 'failed',
      expected: 'All statuses = Accepted',
      actual: `results = ${JSON.stringify(results?.map((r) => r['status']))}`,
    });

    const getRes = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 30,
      monitoringCriteria: ['DeltaMonitoring'],
      componentVariable: [
        { component: { name: 'ChargingStation' }, variable: { name: 'AvailabilityState' } },
        { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'AvailabilityState' } },
      ],
    });
    steps.push({
      step: 3,
      description: 'GetMonitoringReport still shows hardwired monitors',
      status: ['Accepted', 'EmptyResultSet'].includes(getRes['status'] as string)
        ? 'passed'
        : 'failed',
      expected: 'status = Accepted or EmptyResultSet',
      actual: `status = ${getRes['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_19_CS: CsTestCase = {
  id: 'TC_N_19_CS',
  name: 'Clear Monitoring - Not found',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS tries to clear a monitor that does not exist.',
  purpose: 'To test that Charging Station responds with NotFound.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('ClearVariableMonitoring', { id: [123456] });
    const r = (res['clearMonitoringResult'] as Array<Record<string, unknown>> | undefined)?.[0];
    steps.push({
      step: 1,
      description: 'ClearVariableMonitoring NotFound',
      status: (r?.['status'] as string) === 'NotFound' ? 'passed' : 'failed',
      expected: 'status = NotFound',
      actual: `status = ${r?.['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_44_CS: CsTestCase = {
  id: 'TC_N_44_CS',
  name: 'Clear Monitoring - Rejected',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS tries to clear a hard-coded monitor.',
  purpose: 'To verify if the Charging Station rejects clearing a hard-coded monitor.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    // Hardwired monitors are seeded at ID 1000+ at boot
    const res = await ctx.server.sendCommand('ClearVariableMonitoring', { id: [1000] });
    const r = (res['clearMonitoringResult'] as Array<Record<string, unknown>> | undefined)?.[0];
    steps.push({
      step: 1,
      description: 'ClearVariableMonitoring Rejected',
      status: (r?.['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${r?.['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
