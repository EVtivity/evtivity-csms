// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_02_CSMS: TestCase = {
  id: 'TC_C_02_CSMS',
  name: 'Local start transaction - Authorization Invalid/Unknown',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS.',
  purpose: 'To verify whether the CSMS is able to report that an idToken is NOT valid.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    // Step 2: Send AuthorizeRequest with an invalid idToken
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'INVALID-TOKEN-99999', type: 'ISO14443' },
    });

    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string | undefined;
    const validStatuses = ['Invalid', 'Unknown'];
    const statusValid = authStatus != null && validStatuses.includes(authStatus);

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with invalid idToken',
      status: statusValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Invalid or Unknown',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
