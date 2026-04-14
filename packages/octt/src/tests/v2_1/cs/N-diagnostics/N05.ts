// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_16_CS: CsTestCase = {
  id: 'TC_N_16_CS',
  name: 'Set Monitoring Level - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sets a monitoring level to filter events by severity.',
  purpose: 'To test that Charging Station accepts monitoring level and correctly filters events.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetMonitoringLevel', { severity: 7 });
    steps.push({
      step: 1,
      description: 'SetMonitoringLevelResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_17_CS: CsTestCase = {
  id: 'TC_N_17_CS',
  name: 'Set Monitoring Level - Out of range',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sets a monitoring level with out-of-range values.',
  purpose: 'To test that Charging Station rejects out-of-range severity values.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res1 = await ctx.server.sendCommand('SetMonitoringLevel', { severity: 10 });
    steps.push({
      step: 1,
      description: 'SetMonitoringLevelResponse Rejected for severity 10',
      status: (res1['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('SetMonitoringLevel', { severity: -1 });
    steps.push({
      step: 2,
      description: 'SetMonitoringLevelResponse Rejected for severity -1',
      status: (res2['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${res2['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
