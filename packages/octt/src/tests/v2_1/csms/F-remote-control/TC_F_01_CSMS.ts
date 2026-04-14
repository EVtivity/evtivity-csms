// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send StatusNotification
async function bootAndStatus(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Occupied',
    evseId: 1,
    connectorId: 1,
  });
}

/**
 * TC_F_01_CSMS: Remote start transaction - Cable plugin first
 *
 * Before: State is EVConnectedPreSession
 * Scenario:
 *   1. CSMS sends RequestStartTransactionRequest
 *   2. Test System responds with Accepted + transactionId
 *   3. Test System sends TransactionEvent Updated (RemoteStart)
 *   4. CSMS responds with TransactionEventResponse
 */
export const TC_F_01_CSMS: TestCase = {
  id: 'TC_F_01_CSMS',
  name: 'Remote start transaction - Cable plugin first',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR wait for/trigger a RequestStartTransactionRequest.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a charging session when the EV is already connected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedRequestStart = false;
    let remoteStartId = 0;
    let hasValidIdToken = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStartTransaction') {
          receivedRequestStart = true;
          remoteStartId = Number(payload['remoteStartId'] ?? 0);
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasValidIdToken = true;
          }
          const txId = `OCTT-TX-${String(Date.now())}`;
          return { status: 'Accepted', transactionId: txId };
        }
        return { status: 'NotSupported' };
      },
    );

    // Wait for CSMS to send RequestStartTransaction
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestStartTransaction', {
        stationId: ctx.stationId,
        remoteStartId: 1,
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends RequestStartTransactionRequest',
      status: receivedRequestStart ? 'passed' : 'failed',
      expected: 'RequestStartTransactionRequest received',
      actual: receivedRequestStart
        ? 'RequestStartTransactionRequest received'
        : 'No RequestStartTransactionRequest received',
    });

    steps.push({
      step: 2,
      description: 'RequestStartTransactionRequest contains valid idToken',
      status: hasValidIdToken ? 'passed' : 'failed',
      expected: 'idToken with idToken and type fields',
      actual: hasValidIdToken ? 'Valid idToken present' : 'Missing or invalid idToken',
    });

    // Step 3: Send TransactionEvent Updated with RemoteStart
    if (receivedRequestStart) {
      const txId = `OCTT-TX-${String(Date.now())}`;
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'RemoteStart',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          remoteStartId,
          chargingState: 'Charging',
        },
        evse: { id: 1, connectorId: 1 },
      });

      steps.push({
        step: 3,
        description: 'TransactionEvent Updated with RemoteStart accepted',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
