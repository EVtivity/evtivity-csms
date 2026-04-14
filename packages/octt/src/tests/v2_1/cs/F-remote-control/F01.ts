// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_F_01_CS: CsTestCase = {
  id: 'TC_F_01_CS',
  name: 'Remote start transaction - Cable plugin first',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR wait for/trigger a RequestStartTransactionRequest before connecting.',
  purpose:
    'To verify if the Charging Station is able to start a charging session when the EV driver first connects the EV and then the CSMS sends a RequestStartTransactionRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';

    // Set up message handler
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Before: State is EVConnectedPreSession (cable plugged in)
    await ctx.station.plugIn(evseId);
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 1: Execute Reusable State Authorized (remote) - CSMS sends RequestStartTransaction
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

    // Step 2: Execute Reusable State EnergyTransferStarted - wait for TransactionEvent Started
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
