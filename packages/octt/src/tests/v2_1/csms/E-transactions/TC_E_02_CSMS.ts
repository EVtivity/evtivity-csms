// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_E_02_CSMS: TestCase = {
  id: 'TC_E_02_CSMS',
  name: 'Start transaction options - EnergyTransfer',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when the energy transfer has started.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as string;
    steps.push({
      step: 1,
      description: 'Send AuthorizeRequest, expect Accepted',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${authStatus}`,
    });

    // Step 2: StatusNotification Occupied
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Occupied',
      evseId: 1,
      connectorId: 1,
    });
    steps.push({
      step: 2,
      description: 'Send StatusNotification (Occupied)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    // Step 3: TransactionEvent Started with Charging
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const txIdTokenStatus = (txRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as
      | string
      | undefined;
    steps.push({
      step: 3,
      description: 'Send TransactionEvent Started (Charging), expect idTokenInfo.status Accepted',
      status: txIdTokenStatus === 'Accepted' || txIdTokenStatus == null ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted (if present)',
      actual:
        txIdTokenStatus != null
          ? `idTokenInfo.status = ${txIdTokenStatus}`
          : 'idTokenInfo not in response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
