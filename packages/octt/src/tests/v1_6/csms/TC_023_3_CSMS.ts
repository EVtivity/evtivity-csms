// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_023_3_CSMS: TestCase = {
  id: 'TC_023_3_CSMS',
  name: 'Start Charging Session - Authorize Blocked (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'EV Driver is not authorized (blocked idTag).',
  purpose: 'Verify the CSMS responds with Blocked on Authorize for a blocked idTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const authResp = await ctx.client.sendCall('Authorize', { idTag: 'BLOCKED_TAG_001' });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    const status = String(authStatus?.['status']);
    steps.push({
      step: 1,
      description: 'Send Authorize with blocked idTag and expect Blocked',
      status: status === 'Blocked' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Blocked',
      actual: `idTagInfo.status = ${status}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
