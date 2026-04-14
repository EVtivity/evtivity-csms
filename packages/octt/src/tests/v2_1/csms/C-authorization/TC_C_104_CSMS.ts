// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_104_CSMS: TestCase = {
  id: 'TC_C_104_CSMS',
  name: 'Authorization with prepaid card - no credit',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case verifies if the CSMS is able to authorize a prepaid card for a transaction.',
  purpose: 'To verify if the CSMS is able to reject a prepaid card with no credit.',
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

    // Step 2: Send AuthorizeRequest with prepaid card that has no credit
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-PREPAID-NOCREDIT', type: 'ISO14443' },
    });

    const authIdTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = authIdTokenInfo?.['status'] as string | undefined;
    const cacheExpiry = authIdTokenInfo?.['cacheExpiryDateTime'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with prepaid card (no credit)',
      status: authStatus === 'NoCredit' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = NoCredit',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    steps.push({
      step: 3,
      description: 'Verify cacheExpiryDateTime is present',
      status: cacheExpiry != null ? 'passed' : 'failed',
      expected: 'idTokenInfo.cacheExpiryDateTime present',
      actual: `cacheExpiryDateTime = ${String(cacheExpiry)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
