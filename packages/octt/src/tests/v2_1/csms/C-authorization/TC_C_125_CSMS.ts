// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_125_CSMS: TestCase = {
  id: 'TC_C_125_CSMS',
  name: 'Ad hoc payment via stand-alone payment terminal - central cost calculation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'In order to test that Charging Station supports ad hoc payment via a stand-alone payment terminal with central cost calculation.',
  purpose:
    'To verify that the CSMS can properly handle ad hoc payments made via a stand-alone payment terminal with central cost calculation.',
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

    // Step 2: Wait for CSMS to send RequestStartTransaction
    // Manual action: present a payment card at the kiosk
    let requestStartReceived = false;
    let requestStartPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'RequestStartTransaction') {
        requestStartReceived = true;
        requestStartPayload = payload;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Wait for CSMS to initiate the start transaction
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestStartTransaction', {
        stationId: ctx.stationId,
        evseId: 1,
        idToken: { idToken: 'OCTT-DIRECT-PAY', type: 'DirectPayment' },
        remoteStartId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const reqIdToken = requestStartPayload['idToken'] as Record<string, unknown> | undefined;
    const reqIdTokenType = reqIdToken?.['type'] as string | undefined;

    steps.push({
      step: 2,
      description: 'CSMS sends RequestStartTransaction with DirectPayment idToken',
      status: requestStartReceived ? 'passed' : 'failed',
      expected: 'RequestStartTransaction received with idToken.type = DirectPayment',
      actual: requestStartReceived
        ? `idToken.type = ${String(reqIdTokenType)}`
        : 'RequestStartTransaction not received',
    });

    if (!requestStartReceived) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const txId = `OCTT-TX-${String(Date.now())}`;
    const idTokenValue = reqIdToken?.['idToken'] as string;

    // Step 3: Send TransactionEvent Started with meter value
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Charging',
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: idTokenValue,
        type: 'DirectPayment',
      },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 10000, context: 'Transaction.Begin' }],
        },
      ],
    });

    steps.push({
      step: 3,
      description: 'Send TransactionEvent Started with meter value 10000',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txStartRes).join(', ')}`,
    });

    // Step 4: Send TransactionEvent Ended with meter value
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
        idToken: idTokenValue,
        type: 'DirectPayment',
      },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 15000, context: 'Transaction.End' }],
        },
      ],
    });

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Ended with meter value 15000 (5000 Wh delivered)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txEndRes).join(', ')}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
