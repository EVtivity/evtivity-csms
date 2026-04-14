// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_023_2_CSMS: TestCase = {
  id: 'TC_023_2_CSMS',
  name: 'Start Charging Session - Authorize Expired (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'EV Driver is not authorized (expired idTag).',
  purpose: 'Verify the CSMS responds with Expired on Authorize for an expired idTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const authResp = await ctx.client.sendCall('Authorize', { idTag: 'EXPIRED_TAG_001' });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    const status = String(authStatus?.['status']);
    steps.push({
      step: 1,
      description: 'Send Authorize with expired idTag and expect Expired',
      status: status === 'Expired' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Expired',
      actual: `idTagInfo.status = ${status}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
