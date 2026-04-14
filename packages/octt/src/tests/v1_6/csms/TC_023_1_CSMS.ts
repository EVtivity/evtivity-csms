// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_023_1_CSMS: TestCase = {
  id: 'TC_023_1_CSMS',
  name: 'Start Charging Session - Authorize Invalid (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'EV Driver is not authorized (invalid idTag).',
  purpose: 'Verify the CSMS responds with Invalid on Authorize for an unknown idTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const authResp = await ctx.client.sendCall('Authorize', { idTag: 'INVALID_TAG_999' });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    const status = String(authStatus?.['status']);
    steps.push({
      step: 1,
      description: 'Send Authorize with invalid idTag and expect Invalid',
      status: status === 'Invalid' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Invalid',
      actual: `idTagInfo.status = ${status}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
