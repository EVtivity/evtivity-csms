// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_131_CSMS: TestCase = {
  id: 'TC_C_131_CSMS',
  name: 'Ad hoc payment via static or dynamic QR code - success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'In order to test that CSMS supports QR codes.',
  purpose:
    'To verify if the CSMS is able to respond correctly when a QR code is scanned on Charging Station.',
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

    // Step 2: Wait for CSMS to send RequestStartTransaction after QR code payment
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

    // Wait for CSMS to initiate
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestStartTransaction', {
        stationId: ctx.stationId,
        evseId: 1,
        idToken: { idToken: 'OCTT-QR-PAY', type: 'DirectPayment' },
        remoteStartId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const reqIdToken = requestStartPayload['idToken'] as Record<string, unknown> | undefined;
    const reqIdTokenValue = reqIdToken?.['idToken'] as string | undefined;
    const reqIdTokenType = reqIdToken?.['type'] as string | undefined;

    steps.push({
      step: 2,
      description: 'CSMS sends RequestStartTransaction with DirectPayment idToken',
      status: requestStartReceived && reqIdTokenType === 'DirectPayment' ? 'passed' : 'failed',
      expected: 'RequestStartTransaction with idToken.type = DirectPayment',
      actual: requestStartReceived
        ? `idToken.idToken = ${String(reqIdTokenValue)}, idToken.type = ${String(reqIdTokenType)}`
        : 'RequestStartTransaction not received',
    });

    if (!requestStartReceived) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const txId = `OCTT-TX-${String(Date.now())}`;
    const remoteStartId = requestStartPayload['remoteStartId'] as number | undefined;

    // Step 3: Send TransactionEvent Started
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Charging',
        remoteStartId,
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: reqIdTokenValue,
        type: 'DirectPayment',
      },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 10000, context: 'Transaction.Begin' }],
        },
      ],
    });

    const txIdTokenInfo = txStartRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const txStatus = txIdTokenInfo?.['status'] as string | undefined;
    const txLimit = txStartRes['transactionLimit'] as Record<string, unknown> | undefined;
    const maxEnergy = txLimit?.['maxEnergy'] as number | undefined;

    steps.push({
      step: 3,
      description: 'Send TransactionEvent Started with RemoteStart trigger',
      status: txStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(txStatus)}`,
    });

    steps.push({
      step: 4,
      description: 'Verify transactionLimit.maxEnergy is set to 20000',
      status: maxEnergy === 20000 ? 'passed' : 'failed',
      expected: 'transactionLimit.maxEnergy = 20000',
      actual: `transactionLimit.maxEnergy = ${String(maxEnergy)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
