// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_43_CSMS: TestCase = {
  id: 'TC_C_43_CSMS',
  name: 'Authorization by GroupId - Invalid status with Local Authorization List',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId.',
  purpose:
    'To verify if the CSMS is able to correctly handle the Authorization of idTokens with the same GroupId which are in the local authorization list.',
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

    // Step 2: Send StatusNotification
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 3: Send TransactionEvent Started with first valid idToken
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes1 = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const idTokenInfo1 = txRes1['idTokenInfo'] as Record<string, unknown> | undefined;
    const status1 = idTokenInfo1?.['status'] as string | undefined;
    const groupIdToken1 = idTokenInfo1?.['groupIdToken'] as Record<string, unknown> | undefined;

    steps.push({
      step: 2,
      description: 'Send TransactionEvent Started with first valid idToken',
      status: status1 === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(status1)}`,
    });

    const groupIdTokenValue1 = groupIdToken1?.['idToken'] as string | undefined;
    const groupIdTokenValid1 =
      groupIdToken1 != null &&
      typeof groupIdTokenValue1 === 'string' &&
      groupIdTokenValue1.length > 0;

    steps.push({
      step: 3,
      description: 'Verify groupIdToken is present with valid idToken value',
      status: groupIdTokenValid1 ? 'passed' : 'failed',
      expected: 'idTokenInfo.groupIdToken present with non-empty idToken',
      actual:
        groupIdToken1 != null
          ? `groupIdToken.idToken = ${String(groupIdTokenValue1)}`
          : 'groupIdToken absent',
    });

    // Step 4: Send AuthorizeRequest with second valid idToken (same GroupId)
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
    });

    const authIdTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = authIdTokenInfo?.['status'] as string | undefined;
    const authGroupIdToken = authIdTokenInfo?.['groupIdToken'] as
      | Record<string, unknown>
      | undefined;

    steps.push({
      step: 4,
      description: 'Send AuthorizeRequest with second idToken (same GroupId)',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    const authGroupIdTokenValue = authGroupIdToken?.['idToken'] as string | undefined;
    const authGroupIdTokenValid =
      authGroupIdToken != null &&
      typeof authGroupIdTokenValue === 'string' &&
      authGroupIdTokenValue.length > 0;

    steps.push({
      step: 5,
      description: 'Verify groupIdToken present in AuthorizeResponse with valid idToken value',
      status: authGroupIdTokenValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.groupIdToken present with non-empty idToken',
      actual:
        authGroupIdToken != null
          ? `groupIdToken.idToken = ${String(authGroupIdTokenValue)}`
          : 'groupIdToken absent',
    });

    // Step 5: Send TransactionEvent Updated with second idToken for StopAuthorized
    const txRes2 = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Idle' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
    });

    const idTokenInfo2 = txRes2['idTokenInfo'] as Record<string, unknown> | undefined;
    const status2 = idTokenInfo2?.['status'] as string | undefined;

    steps.push({
      step: 6,
      description: 'Send TransactionEvent Updated with second idToken (StopAuthorized)',
      status: status2 === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(status2)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
