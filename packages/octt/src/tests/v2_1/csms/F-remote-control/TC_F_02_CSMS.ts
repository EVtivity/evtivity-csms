// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station
async function boot(ctx: {
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
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });
}

/**
 * TC_F_02_CSMS: Remote start transaction - Remote start first - AuthorizeRemoteStart is true
 *
 * Scenario:
 *   1. CSMS sends RequestStartTransactionRequest
 *   2. Test System responds with Accepted (transactionId omitted)
 *   3. Test System sends AuthorizeRequest
 *   4. CSMS responds with AuthorizeResponse
 *   5. Test System sends TransactionEvent Started (RemoteStart)
 *   6. CSMS responds with TransactionEventResponse
 */
export const TC_F_02_CSMS: TestCase = {
  id: 'TC_F_02_CSMS',
  name: 'Remote start transaction - Remote start first - AuthorizeRemoteStart is true',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a charging session when the Charging Station receives a remote start with AuthorizeRemoteStart enabled.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedRequestStart = false;
    let hasValidIdToken = false;
    let idTokenValue = '';
    let idTokenType = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStartTransaction') {
          receivedRequestStart = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null) {
            idTokenValue = String(idToken['idToken'] ?? '');
            idTokenType = String(idToken['type'] ?? '');
            if (idTokenValue !== '' && idTokenType !== '') {
              hasValidIdToken = true;
            }
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

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
      description: 'Request contains valid idToken',
      status: hasValidIdToken ? 'passed' : 'failed',
      expected: 'idToken with idToken and type',
      actual: `idToken = ${idTokenValue}, type = ${idTokenType}`,
    });

    if (receivedRequestStart) {
      // Step 3: Send AuthorizeRequest
      const authRes = await ctx.client.sendCall('Authorize', {
        idToken: { idToken: idTokenValue, type: idTokenType },
      });

      const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
      const authStatus = String(idTokenInfo?.['status'] ?? '');

      steps.push({
        step: 3,
        description: 'AuthorizeResponse received with status',
        status: authStatus !== '' ? 'passed' : 'failed',
        expected: 'AuthorizeResponse with idTokenInfo.status',
        actual: `status = ${authStatus}`,
      });

      // Step 5: Send TransactionEvent Started
      const txId = `OCTT-TX-${String(Date.now())}`;
      const remoteStartId = Math.floor(Math.random() * 100000);
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'RemoteStart',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          remoteStartId,
          chargingState: 'Charging',
        },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: idTokenValue, type: idTokenType },
      });

      steps.push({
        step: 4,
        description: 'TransactionEvent Started with RemoteStart accepted',
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

/**
 * TC_F_03_CSMS: Remote start transaction - Remote start first - AuthorizeRemoteStart is false
 *
 * Scenario:
 *   1. CSMS sends RequestStartTransactionRequest
 *   2. Test System responds with Accepted (transactionId omitted)
 *   3. Test System sends TransactionEvent Started (RemoteStart)
 *   4. CSMS responds with TransactionEventResponse (idTokenInfo.status = Accepted)
 */
export const TC_F_03_CSMS: TestCase = {
  id: 'TC_F_03_CSMS',
  name: 'Remote start transaction - Remote start first - AuthorizeRemoteStart is false',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a charging session when the Charging Station receives a remote start with AuthorizeRemoteStart disabled.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedRequestStart = false;
    let hasValidIdToken = false;
    let idTokenValue = '';
    let idTokenType = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStartTransaction') {
          receivedRequestStart = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null) {
            idTokenValue = String(idToken['idToken'] ?? '');
            idTokenType = String(idToken['type'] ?? '');
            if (idTokenValue !== '' && idTokenType !== '') {
              hasValidIdToken = true;
            }
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

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
      description: 'Request contains valid idToken',
      status: hasValidIdToken ? 'passed' : 'failed',
      expected: 'idToken with idToken and type',
      actual: `idToken = ${idTokenValue}, type = ${idTokenType}`,
    });

    if (receivedRequestStart) {
      // Step 3: Send TransactionEvent Started (no Authorize call)
      const txId = `OCTT-TX-${String(Date.now())}`;
      const remoteStartId = Math.floor(Math.random() * 100000);
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'RemoteStart',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          remoteStartId,
          chargingState: 'Charging',
        },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: idTokenValue, type: idTokenType },
      });

      const idTokenInfo = txRes['idTokenInfo'] as Record<string, unknown> | undefined;
      const txStatus = String(idTokenInfo?.['status'] ?? '');

      steps.push({
        step: 3,
        description: 'TransactionEventResponse has idTokenInfo.status = Accepted',
        status: txStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'idTokenInfo.status = Accepted',
        actual: `idTokenInfo.status = ${txStatus}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_F_04_CSMS: Remote start transaction - Remote start first - Cable plugin timeout
 *
 * Scenario:
 *   1. CSMS sends RequestStartTransactionRequest
 *   2. Test System responds with Accepted (transactionId omitted)
 *   3. Test System sends TransactionEvent Started (RemoteStart)
 *   4. CSMS responds with TransactionEventResponse
 *   5. Test System sends TransactionEvent Updated (EVConnectTimeout)
 *   6. CSMS responds with TransactionEventResponse
 */
export const TC_F_04_CSMS: TestCase = {
  id: 'TC_F_04_CSMS',
  name: 'Remote start transaction - Remote start first - Cable plugin timeout',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that deauthorizes the transaction after the cable plugin timeout.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedRequestStart = false;
    let idTokenValue = '';
    let idTokenType = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStartTransaction') {
          receivedRequestStart = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null) {
            idTokenValue = String(idToken['idToken'] ?? '');
            idTokenType = String(idToken['type'] ?? '');
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

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

    if (receivedRequestStart) {
      const txId = `OCTT-TX-${String(Date.now())}`;
      const remoteStartId = Math.floor(Math.random() * 100000);

      // Step 3: TransactionEvent Started
      const startRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'RemoteStart',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          remoteStartId,
        },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: idTokenValue, type: idTokenType },
      });

      steps.push({
        step: 2,
        description: 'TransactionEvent Started accepted',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(startRes).join(', ')}`,
      });

      // Step 5: TransactionEvent Updated with EVConnectTimeout
      const timeoutRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'EVConnectTimeout',
        seqNo: 1,
        transactionInfo: {
          transactionId: txId,
        },
        evse: { id: 1, connectorId: 1 },
      });

      steps.push({
        step: 3,
        description: 'TransactionEvent Updated with EVConnectTimeout accepted',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(timeoutRes).join(', ')}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
