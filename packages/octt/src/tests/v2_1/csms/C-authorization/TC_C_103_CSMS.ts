// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_103_CSMS: TestCase = {
  id: 'TC_C_103_CSMS',
  name: 'Authorization with prepaid card - success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case verifies if the CSMS is able to authorize a prepaid card for a transaction.',
  purpose: 'To verify if the CSMS is able to authorize a prepaid card for a transaction.',
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

    // Step 2: Send AuthorizeRequest with prepaid card idToken
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-PREPAID-001', type: 'ISO14443' },
    });

    const authIdTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = authIdTokenInfo?.['status'] as string | undefined;
    const cacheExpiry = authIdTokenInfo?.['cacheExpiryDateTime'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with prepaid card idToken',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    steps.push({
      step: 3,
      description: 'Verify cacheExpiryDateTime is present',
      status: cacheExpiry != null ? 'passed' : 'failed',
      expected: 'idTokenInfo.cacheExpiryDateTime present',
      actual: `cacheExpiryDateTime = ${String(cacheExpiry)}`,
    });

    // Step 3: Send TransactionEvent Started with prepaid card
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-PREPAID-001', type: 'ISO14443' },
    });

    const txIdTokenInfo = txRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const txStatus = txIdTokenInfo?.['status'] as string | undefined;
    const txLimit = txRes['transactionLimit'] as Record<string, unknown> | undefined;
    const maxCost = txLimit?.['maxCost'];

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Started with prepaid card idToken',
      status: txStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(txStatus)}`,
    });

    steps.push({
      step: 5,
      description: 'Verify transactionLimit.maxCost is present',
      status: maxCost != null ? 'passed' : 'failed',
      expected: 'transactionLimit.maxCost present',
      actual: `transactionLimit.maxCost = ${String(maxCost)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
