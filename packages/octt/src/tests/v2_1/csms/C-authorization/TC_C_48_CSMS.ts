// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_48_CSMS: TestCase = {
  id: 'TC_C_48_CSMS',
  name: 'Stop Transaction with a Master Pass - With UI - Specific transactions',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how somebody with a Master Pass can stop a specific ongoing transaction.',
  purpose:
    'To verify if the CSMS is able to correctly respond on a request to stop a transaction when an idToken with MasterPass GroupId is used.',
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

    // Step 2: Start a transaction on EVSE 1
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // Step 3: Send AuthorizeRequest with valid idToken (associated with MasterPass)
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const authIdTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = authIdTokenInfo?.['status'] as string | undefined;
    const authGroupIdToken = authIdTokenInfo?.['groupIdToken'] as
      | Record<string, unknown>
      | undefined;

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with valid idToken',
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
      step: 3,
      description: 'Verify groupIdToken contains MasterPass GroupId',
      status: authGroupIdTokenValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.groupIdToken present with non-empty idToken',
      actual:
        authGroupIdToken != null
          ? `groupIdToken.idToken = ${String(authGroupIdTokenValue)}`
          : 'groupIdToken absent',
    });

    // Step 4: Send TransactionEvent Ended with MasterPass stoppedReason
    const txEndRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId, stoppedReason: 'MasterPass' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-MASTERPASS-001', type: 'ISO14443' },
    });

    const endIdTokenInfo = txEndRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const endStatus = endIdTokenInfo?.['status'] as string | undefined;
    const endGroupIdToken = endIdTokenInfo?.['groupIdToken'] as Record<string, unknown> | undefined;
    const endGroupIdTokenValue = endGroupIdToken?.['idToken'] as string | undefined;
    const endGroupIdTokenValid =
      endGroupIdToken != null &&
      typeof endGroupIdTokenValue === 'string' &&
      endGroupIdTokenValue.length > 0;

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Ended with MasterPass stoppedReason',
      status: endStatus === 'Accepted' && endGroupIdTokenValid ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted, groupIdToken present with non-empty idToken',
      actual: `idTokenInfo.status = ${String(endStatus)}, groupIdToken.idToken = ${endGroupIdToken != null ? String(endGroupIdTokenValue) : 'absent'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
