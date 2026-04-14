// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_47_CSMS: TestCase = {
  id: 'TC_C_47_CSMS',
  name: 'Stop Transaction with a Master Pass - With UI - All transactions',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how somebody with a Master Pass can stop all ongoing transactions.',
  purpose:
    'To verify if the CSMS is able to correctly respond on a request to stop all transactions when an idToken with MasterPass GroupId is used.',
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

    // Step 2: Set up two active transactions on EVSE 1 and EVSE 2
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 2,
      connectorId: 1,
    });

    const txId1 = `OCTT-TX1-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId1, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const txId2 = `OCTT-TX2-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId2, chargingState: 'Charging' },
      evse: { id: 2, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
    });

    // Step 3: Send AuthorizeRequest with MasterPass idToken
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-MASTERPASS-001', type: 'ISO14443' },
    });

    const authIdTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = authIdTokenInfo?.['status'] as string | undefined;
    const authGroupIdToken = authIdTokenInfo?.['groupIdToken'] as
      | Record<string, unknown>
      | undefined;

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with MasterPass idToken',
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

    // Step 4: Send TransactionEvent Ended for both EVSEs with MasterPass stoppedReason
    const txEndRes1 = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId1, stoppedReason: 'MasterPass' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-MASTERPASS-001', type: 'ISO14443' },
    });

    const endIdTokenInfo1 = txEndRes1['idTokenInfo'] as Record<string, unknown> | undefined;
    const endStatus1 = endIdTokenInfo1?.['status'] as string | undefined;
    const endGroupIdToken1 = endIdTokenInfo1?.['groupIdToken'] as
      | Record<string, unknown>
      | undefined;
    const endGroupIdTokenValue1 = endGroupIdToken1?.['idToken'] as string | undefined;
    const endGroupIdTokenValid1 =
      endGroupIdToken1 != null &&
      typeof endGroupIdTokenValue1 === 'string' &&
      endGroupIdTokenValue1.length > 0;

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Ended for EVSE 1 with MasterPass stoppedReason',
      status: endStatus1 === 'Accepted' && endGroupIdTokenValid1 ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted, groupIdToken present with non-empty idToken',
      actual: `idTokenInfo.status = ${String(endStatus1)}, groupIdToken.idToken = ${endGroupIdToken1 != null ? String(endGroupIdTokenValue1) : 'absent'}`,
    });

    const txEndRes2 = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId2, stoppedReason: 'MasterPass' },
      evse: { id: 2, connectorId: 1 },
      idToken: { idToken: 'OCTT-MASTERPASS-001', type: 'ISO14443' },
    });

    const endIdTokenInfo2 = txEndRes2['idTokenInfo'] as Record<string, unknown> | undefined;
    const endStatus2 = endIdTokenInfo2?.['status'] as string | undefined;
    const endGroupIdToken2 = endIdTokenInfo2?.['groupIdToken'] as
      | Record<string, unknown>
      | undefined;
    const endGroupIdTokenValue2 = endGroupIdToken2?.['idToken'] as string | undefined;
    const endGroupIdTokenValid2 =
      endGroupIdToken2 != null &&
      typeof endGroupIdTokenValue2 === 'string' &&
      endGroupIdTokenValue2.length > 0;

    steps.push({
      step: 5,
      description: 'Send TransactionEvent Ended for EVSE 2 with MasterPass stoppedReason',
      status: endStatus2 === 'Accepted' && endGroupIdTokenValid2 ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted, groupIdToken present with non-empty idToken',
      actual: `idTokenInfo.status = ${String(endStatus2)}, groupIdToken.idToken = ${endGroupIdToken2 != null ? String(endGroupIdTokenValue2) : 'absent'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
