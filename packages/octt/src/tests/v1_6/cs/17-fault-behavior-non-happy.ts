// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_041_CS: CsTestCase = {
  id: 'TC_041_CS',
  name: 'Fault Behavior',
  module: '17-fault-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to refuse starting a transaction, when the Charge Point is in fault state.',
  purpose: 'To test if the Charge Point refuses starting a transaction when it is in fault state.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Step 1: StatusNotification Faulted
    const sn = await ctx.server.waitForMessage('StatusNotification', 30_000);
    steps.push({
      step: 1,
      description: 'StatusNotification Faulted',
      status: (sn['status'] as string) === 'Faulted' ? 'passed' : 'failed',
      expected: 'status = Faulted',
      actual: `status = ${String(sn['status'])}`,
    });

    // Step 3: Verify no transaction starts
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
      steps.push({
        step: 3,
        description: 'No StartTransaction in fault state',
        status: 'failed',
        expected: 'No StartTransaction',
        actual: 'StartTransaction received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'No StartTransaction in fault state (correct)',
        status: 'passed',
        expected: 'No StartTransaction',
        actual: 'None received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
