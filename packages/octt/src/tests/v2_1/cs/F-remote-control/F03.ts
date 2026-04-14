// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

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

export const TC_F_08_CS: CsTestCase = {
  id: 'TC_F_08_CS',
  name: 'Remote stop transaction - Success',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to stop a charging session remotely by sending a RequestStopTransactionRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to stop a charging session when it receives a RequestStopTransactionRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EnergyTransferStarted - set up an active transaction
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Capture the transactionId from the started transaction
    let transactionId: string | undefined;
    try {
      const txStarted = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const txInfo = txStarted['transactionInfo'] as Record<string, unknown> | undefined;
      transactionId = txInfo?.['transactionId'] as string | undefined;
    } catch {
      /* already consumed above */
    }
    if (transactionId == null) {
      transactionId = `OCTT-TX-${String(Date.now())}`;
    }

    // Step 1: Execute Reusable State StopAuthorized (remote) - send RequestStopTransaction
    const stopRes = await ctx.server.sendCommand('RequestStopTransaction', {
      transactionId,
    });
    const stopStatus = stopRes['status'] as string;
    steps.push({
      step: 1,
      description: 'RequestStopTransactionResponse - status must be Accepted',
      status: stopStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${stopStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_09_CS: CsTestCase = {
  id: 'TC_F_09_CS',
  name: 'Remote stop transaction - Rejected',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to stop a charging session remotely by sending a RequestStopTransactionRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station will reject a RequestStopTransactionRequest message, if it contains a transactionId that is not known.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EnergyTransferStarted - set up an active transaction
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1-2: Send RequestStopTransactionRequest with unknown transactionId
    const unknownTransactionId = `UNKNOWN-TX-${String(Date.now())}`;
    const stopRes = await ctx.server.sendCommand('RequestStopTransaction', {
      transactionId: unknownTransactionId,
    });
    const stopStatus = stopRes['status'] as string;
    steps.push({
      step: 2,
      description: 'RequestStopTransactionResponse - status must be Rejected',
      status: stopStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${stopStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
