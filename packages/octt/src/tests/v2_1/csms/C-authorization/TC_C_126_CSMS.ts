// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_126_CSMS: TestCase = {
  id: 'TC_C_126_CSMS',
  name: 'Ad hoc payment via stand-alone payment terminal - local cost calculation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'In order to test that Charging Station supports ad hoc payment via a stand-alone payment terminal with local cost calculation.',
  purpose:
    'To verify that the CSMS can properly handle ad hoc payments made via a stand-alone payment terminal with local cost calculation.',
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
        idToken: {
          idToken: 'OCTT-DIRECT-PAY',
          type: 'DirectPayment',
          additionalInfo: [{ additionalIdToken: '1234', type: 'CardLast4Digits' }],
        },
        remoteStartId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const reqIdToken = requestStartPayload['idToken'] as Record<string, unknown> | undefined;
    const reqIdTokenType = reqIdToken?.['type'] as string | undefined;
    const reqEvseId = requestStartPayload['evseId'] as number | undefined;
    const reqRemoteStartId = requestStartPayload['remoteStartId'] as number | undefined;
    const additionalInfo = reqIdToken?.['additionalInfo'] as Record<string, unknown>[] | undefined;
    const additionalIdToken = additionalInfo?.[0]?.['additionalIdToken'] as string | undefined;
    const additionalType = additionalInfo?.[0]?.['type'] as string | undefined;

    steps.push({
      step: 2,
      description: 'CSMS sends RequestStartTransaction',
      status: requestStartReceived ? 'passed' : 'failed',
      expected: 'RequestStartTransaction received',
      actual: requestStartReceived
        ? `evseId = ${String(reqEvseId)}, remoteStartId = ${String(reqRemoteStartId)}`
        : 'RequestStartTransaction not received',
    });

    if (requestStartReceived) {
      steps.push({
        step: 3,
        description:
          'Verify RequestStartTransaction has DirectPayment idToken with CardLast4Digits',
        status:
          reqIdTokenType === 'DirectPayment' && additionalType === 'CardLast4Digits'
            ? 'passed'
            : 'failed',
        expected: 'idToken.type = DirectPayment, additionalInfo.type = CardLast4Digits',
        actual: `idToken.type = ${String(reqIdTokenType)}, additionalInfo.type = ${String(additionalType)}, additionalIdToken = ${String(additionalIdToken)}`,
      });

      const evseIdPresent = reqEvseId != null;
      const remoteStartIdPresent = reqRemoteStartId != null;

      steps.push({
        step: 4,
        description: 'Verify RequestStartTransaction has evseId and remoteStartId',
        status: evseIdPresent && remoteStartIdPresent ? 'passed' : 'failed',
        expected: 'evseId and remoteStartId present',
        actual: `evseId = ${String(reqEvseId)}, remoteStartId = ${String(reqRemoteStartId)}`,
      });
    }

    if (!requestStartReceived) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const txId = `OCTT-TX-${String(Date.now())}`;
    const idTokenValue = reqIdToken?.['idToken'] as string;

    // Step 5: Send TransactionEvent Started
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
        additionalInfo: additionalInfo,
      },
    });

    const txLimit = txStartRes['transactionLimit'] as Record<string, unknown> | undefined;
    const maxCost = txLimit?.['maxCost'];

    steps.push({
      step: 5,
      description: 'Send TransactionEvent Started and verify transactionLimit.maxCost',
      status: maxCost != null ? 'passed' : 'failed',
      expected: 'transactionLimit.maxCost present',
      actual: `transactionLimit.maxCost = ${String(maxCost)}`,
    });

    // Step 6: Send TransactionEvent Ended with local cost details
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
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          fixed: {
            exclTax: 15.0,
            inclTax: 18.15,
            taxRates: [{ type: 'MyTax', tax: 21 }],
          },
          total: {
            exclTax: 15.0,
            inclTax: 18.15,
          },
        },
        totalUsage: { energy: 123, chargingTime: 5, idleTime: 0 },
      },
    });

    steps.push({
      step: 6,
      description: 'Send TransactionEvent Ended with local cost details (18.15 EUR)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txEndRes).join(', ')}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
