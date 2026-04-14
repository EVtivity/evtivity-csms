// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_023_4_CS: CsTestCase = {
  id: 'TC_023_4_CS',
  name: 'Start local Charging Session - Authorize invalid',
  module: '10-basic-actions-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to inform the Charge Point that the EV Driver is not Authorized to start a transaction.',
  purpose: 'To test if the Charge Point does not start a transaction after Authorization fails.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Invalid' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Present invalid identification
    await ctx.station.authorize(1, 'INVALID_TAG');

    // Drain Authorize
    try {
      await ctx.server.waitForMessage('Authorize', 5000);
    } catch {
      /* consumed */
    }

    // Plug in cable
    await ctx.station.plugIn(1);

    // Step 3: StatusNotification Preparing (no transaction should start)
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const snStatus = sn['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StatusNotification Preparing (no transaction)',
      status: snStatus === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(snStatus)}`,
    });

    // Verify no StartTransaction is sent
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
      steps.push({
        step: 4,
        description: 'No StartTransaction should be sent',
        status: 'failed',
        expected: 'No StartTransaction',
        actual: 'StartTransaction received',
      });
    } catch {
      steps.push({
        step: 4,
        description: 'No StartTransaction sent (correct)',
        status: 'passed',
        expected: 'No StartTransaction',
        actual: 'None received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
