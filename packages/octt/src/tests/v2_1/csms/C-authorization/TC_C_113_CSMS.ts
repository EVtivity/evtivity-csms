// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_113_CSMS: TestCase = {
  id: 'TC_C_113_CSMS',
  name: 'Integrated Payment Terminal - Cancelation after start of transaction',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To inform the CSMS that payment has been canceled and the authorization amount has been released.',
  purpose:
    'To verify if the CSMS is able to handle cancelation of a local payment terminal authorization after a transaction has started.',
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

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    const pspRef = `PSP-${String(Date.now())}`;

    // Step 2: Send TransactionEvent Started with DirectPayment
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Charging',
        transactionLimit: { maxCost: 50 },
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: pspRef,
        type: 'DirectPayment',
        additionalInfo: [{ additionalIdToken: '1234', type: 'Last4Digits' }],
      },
    });

    steps.push({
      step: 2,
      description: 'Send TransactionEvent Started with DirectPayment idToken',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txStartRes).join(', ')}`,
    });

    // Step 3: Send TransactionEvent Ended immediately (canceled transaction)
    const txEndRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'Local',
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: pspRef,
        type: 'DirectPayment',
        additionalInfo: [{ additionalIdToken: '1234', type: 'Last4Digits' }],
      },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          total: { exclTax: 0, inclTax: 0 },
        },
        totalUsage: { energy: 0, chargingTime: 0, idleTime: 0 },
      },
    });

    steps.push({
      step: 3,
      description: 'Send TransactionEvent Ended with zero cost (canceled)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txEndRes).join(', ')}`,
    });

    // Step 4: Send NotifySettlement with status Canceled
    try {
      const settlementRes = await ctx.client.sendCall('NotifySettlement', {
        transactionId: txId,
        pspRef,
        status: 'Canceled',
        settlementTime: new Date().toISOString(),
        settlementAmount: 0,
      });

      steps.push({
        step: 4,
        description: 'Send NotifySettlement with status Canceled',
        status: 'passed',
        expected: 'NotifySettlementResponse received',
        actual: `Response keys: ${Object.keys(settlementRes).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'Send NotifySettlement with status Canceled',
        status: 'failed',
        expected: 'NotifySettlementResponse received',
        actual: 'NotifySettlement call failed or not supported',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
