// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';

export const TC_E_01_CSMS: TestCase = {
  id: 'TC_E_01_CSMS',
  name: 'Start transaction options - PowerPathClosed',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when the power path has been closed.',
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
    const resp2 = await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Occupied',
      evseId: 1,
      connectorId: 1,
    });
    pushSendAckStep(steps, 2, 'Send StatusNotification (Occupied)', resp2);

    // Step 3: TransactionEvent Started with SuspendedEVSE
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEVSE' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    pushSendAckStep(
      steps,
      3,
      'Send TransactionEvent Started (SuspendedEVSE)',
      txStartRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(txStartRes).join(', ')}`,
    );

    // Step 4: TransactionEvent Updated with Charging
    const txUpdateRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    });
    pushSendAckStep(
      steps,
      4,
      'Send TransactionEvent Updated (Charging)',
      txUpdateRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(txUpdateRes).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
