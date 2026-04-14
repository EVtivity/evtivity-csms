// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_118_CSMS: TestCase = {
  id: 'TC_C_118_CSMS',
  name: 'Settlement at end of transaction - settled by CS, receipt by CSMS',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'In order to test that Charging Station supports settlement at the end of a transaction where the settlement is done by the Charging Station.',
  purpose:
    'To verify that the CSMS can properly handle a transaction where the settlement is done by the Charging Station.',
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
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: pspRef,
        type: 'DirectPayment',
        additionalInfo: [{ additionalIdToken: '4242', type: 'CardLast4Digits' }],
      },
    });

    steps.push({
      step: 2,
      description: 'Send TransactionEvent Started with DirectPayment',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txStartRes).join(', ')}`,
    });

    // Step 3: Send TransactionEvent Ended with cost details
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
      },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          total: { exclTax: 15.0, inclTax: 18.15 },
          fixed: {
            exclTax: 15.0,
            inclTax: 18.15,
            taxRates: [{ type: 'MyTax', tax: 21 }],
          },
        },
        totalUsage: { energy: 123, chargingTime: 5, idleTime: 0 },
      },
    });

    steps.push({
      step: 3,
      description: 'Send TransactionEvent Ended with cost details',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txEndRes).join(', ')}`,
    });

    // Step 4: Send NotifySettlement with status Settled (CS settled the amount)
    try {
      const settlementRes = await ctx.client.sendCall('NotifySettlement', {
        transactionId: txId,
        pspRef,
        status: 'Settled',
        settlementTime: new Date().toISOString(),
        settlementAmount: 18.15,
      });

      steps.push({
        step: 4,
        description: 'Send NotifySettlement with status Settled and amount 18.15',
        status: 'passed',
        expected: 'NotifySettlementResponse received',
        actual: `Response keys: ${Object.keys(settlementRes).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'Send NotifySettlement with status Settled',
        status: 'failed',
        expected: 'NotifySettlementResponse received',
        actual: 'NotifySettlement call failed or not supported',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
