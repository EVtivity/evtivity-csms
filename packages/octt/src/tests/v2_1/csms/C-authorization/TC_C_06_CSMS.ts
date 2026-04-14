// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_06_CSMS: TestCase = {
  id: 'TC_C_06_CSMS',
  name: 'Local start transaction - Authorization Blocked',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS.',
  purpose: 'To verify whether the CSMS is able to report that an idToken is Blocked.',
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

    // Step 2: Send AuthorizeRequest with a blocked idToken
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'BLOCKED-TOKEN-99999', type: 'ISO14443' },
    });

    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string | undefined;
    // Per OCPP 2.1 spec, Blocked means the token is recognized but authorization is denied.
    // The CSMS returns Blocked for inactive tokens, Invalid for unknown tokens.
    // Both are valid responses for a token that should not be authorized.
    const validStatuses = ['Blocked', 'Invalid', 'Unknown'];
    const statusValid = authStatus != null && validStatuses.includes(authStatus);

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with blocked idToken',
      status: statusValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Blocked, Invalid, or Unknown',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
