// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const defaultHandler = async (action: string): Promise<Record<string, unknown>> => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return {};
  return {};
};

export const TC_F_02_CS: CsTestCase = {
  id: 'TC_F_02_CS',
  name: 'Remote start transaction - Remote start first - AuthorizeRemoteStart is true',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the Charging Station is able to start a charging session when the Charging Station receives a RequestStartTransactionRequest before the EV is connected and AuthorizeRemoteStart is true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1: Execute Reusable State Authorized (remote) - CSMS sends RequestStartTransaction first
    const startRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken, type: idTokenType },
      evseId,
    });
    const startStatus = startRes['status'] as string;
    steps.push({
      step: 1,
      description: 'RequestStartTransactionResponse - status must be Accepted',
      status: startStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${startStatus}`,
    });

    // Plug in cable after remote start
    await ctx.station.plugIn(evseId);
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 2: Execute Reusable State EnergyTransferStarted
    const txEvent = await ctx.server.waitForMessage('TransactionEvent', 30000);
    const eventType = txEvent['eventType'] as string;
    steps.push({
      step: 2,
      description: 'TransactionEventRequest received - eventType must be Started',
      status: eventType === 'Started' ? 'passed' : 'failed',
      expected: 'eventType = Started',
      actual: `eventType = ${eventType}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_03_CS: CsTestCase = {
  id: 'TC_F_03_CS',
  name: 'Remote start transaction - Remote start first - AuthorizeRemoteStart is false',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the Charging Station is able to start a charging session when the Charging Station receives a RequestStartTransactionRequest before the EV is connected and AuthorizeRemoteStart is false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1: Execute Reusable State Authorized (remote) - CSMS sends RequestStartTransaction first
    const startRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken, type: idTokenType },
      evseId,
    });
    const startStatus = startRes['status'] as string;
    steps.push({
      step: 1,
      description: 'RequestStartTransactionResponse - status must be Accepted',
      status: startStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${startStatus}`,
    });

    // Plug in cable after remote start
    await ctx.station.plugIn(evseId);
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 2: Execute Reusable State EnergyTransferStarted
    const txEvent = await ctx.server.waitForMessage('TransactionEvent', 30000);
    const eventType = txEvent['eventType'] as string;
    steps.push({
      step: 2,
      description: 'TransactionEventRequest received - eventType must be Started',
      status: eventType === 'Started' ? 'passed' : 'failed',
      expected: 'eventType = Started',
      actual: `eventType = ${eventType}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_04_CS: CsTestCase = {
  id: 'TC_F_04_CS',
  name: 'Remote start transaction - Remote start first - Cable plugin timeout',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first wait for/trigger a RequestStartTransactionRequest OR connect the EV.',
  purpose:
    'To verify if the Charging Station is able to deauthorize the transaction after the EVConnectionTimeout has expired.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';

    ctx.server.setMessageHandler(defaultHandler);

    // Set a short EVConnectionTimeOut for faster test execution
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          attributeValue: '3',
          component: { name: 'TxCtrlr' },
          variable: { name: 'EVConnectionTimeOut' },
        },
      ],
    });

    // Before: State is Authorized (remote) - send RequestStartTransaction but do NOT plug in
    const startRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken, type: idTokenType },
      evseId,
    });
    const startStatus = startRes['status'] as string;
    if (startStatus !== 'Accepted') {
      steps.push({
        step: 0,
        description: 'Setup: RequestStartTransactionResponse - status must be Accepted',
        status: 'failed',
        expected: 'status = Accepted',
        actual: `status = ${startStatus}`,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 1: Wait for TransactionEventRequest with EVConnectTimeout trigger.
    // Skip any Started/Updated events that arrive before the timeout fires.
    let txEvent: Record<string, unknown> | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await ctx.server.waitForMessage('TransactionEvent', remaining);
        if (msg['triggerReason'] === 'EVConnectTimeout') {
          txEvent = msg;
          break;
        }
      } catch {
        break;
      }
    }
    const triggerReason = txEvent?.['triggerReason'] as string | undefined;
    const eventType = txEvent?.['eventType'] as string | undefined;
    steps.push({
      step: 1,
      description:
        'TransactionEventRequest - triggerReason must be EVConnectTimeout, eventType must be Ended',
      status: triggerReason === 'EVConnectTimeout' && eventType === 'Ended' ? 'passed' : 'failed',
      expected: 'triggerReason = EVConnectTimeout, eventType = Ended',
      actual: `triggerReason = ${String(triggerReason)}, eventType = ${String(eventType)}`,
    });

    // Drain StatusNotification Available that comes after timeout cleanup
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 3: Execute Reusable State Authorized (remote) to verify EVSE ready for new session
    const retryRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken, type: idTokenType },
      evseId,
    });
    const retryStatus = retryRes['status'] as string;
    steps.push({
      step: 3,
      description:
        'RequestStartTransactionResponse - status must be Accepted (EVSE ready for new session)',
      status: retryStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${retryStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
