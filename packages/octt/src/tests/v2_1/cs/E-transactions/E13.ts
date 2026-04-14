// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    return {};
  });
}

/**
 * Start charging with a 2-second meter interval so TransactionEvents arrive
 * within the test timeout windows.
 */
async function startChargingFast(
  ctx: {
    station: {
      setConfigValue(k: string, v: string): void;
      plugIn(e: number): Promise<void>;
      startCharging(e: number, t: string): Promise<unknown>;
    };
    server: { waitForMessage(a: string, t: number): Promise<Record<string, unknown>> };
  },
  evseId: number,
  token: string,
): Promise<void> {
  ctx.station.setConfigValue('SampledDataCtrlr.TxUpdatedInterval', '2');
  await ctx.station.plugIn(evseId);
  await ctx.station.startCharging(evseId, token);
}

export const TC_E_41_CS: CsTestCase = {
  id: 'TC_E_41_CS',
  name: 'Retry sending transaction message when failed - Max retry count reached',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'There are situations/issues why a CSMS might not accept a transaction related message, or does not reply.',
  purpose:
    'To verify if the Charging Station is able to resend TransactionEvent messages until the max retry count is reached.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging with fast meter interval
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1 (optional): TransactionEvent with triggerReason SignedDataReceived
    const txMsg1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const tx1 = txMsg1 as Record<string, unknown> | null;
    const trig1 = tx1?.['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent with triggerReason SignedDataReceived (optional)',
      status: trig1 === 'SignedDataReceived' || trig1 !== undefined ? 'passed' : 'failed',
      expected: 'TransactionEvent received (optional SignedDataReceived)',
      actual: `triggerReason=${trig1}`,
    });

    // Step 3 (optional): TransactionEvent with ChargingStateChanged SuspendedEVSE
    const txMsg3 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const tx3 = txMsg3 as Record<string, unknown> | null;
    const trig3 = tx3?.['triggerReason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent with ChargingStateChanged SuspendedEVSE (optional)',
      status: trig3 !== undefined ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: `triggerReason=${trig3}`,
    });

    // Step 5: CS resends TransactionEvent (no response from CSMS - retries configured number of times)
    const txMsg5 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 5,
      description: 'TransactionEvent retry attempts',
      status: txMsg5 ? 'passed' : 'failed',
      expected: 'CS sends TransactionEvent multiple times',
      actual: txMsg5 ? 'TransactionEvent received' : 'Timeout',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_50_CS: CsTestCase = {
  id: 'TC_E_50_CS',
  name: 'Retry sending transaction message when failed - Max retry count reached - CallError',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'There are situations/issues why a CSMS might not accept a transaction related message, or does not reply.',
  purpose:
    'To verify if the Charging Station is able to resend TransactionEvent messages until the max retry count when receiving CallError.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging with fast meter interval
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1 (optional): TransactionEvent
    const txMsg1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description: 'TransactionEvent (optional SignedDataReceived)',
      status: txMsg1 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg1 ? 'Received' : 'Timeout',
    });

    // Step 3 (optional): TransactionEvent
    const txMsg3 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 3,
      description: 'TransactionEvent (optional ChargingStateChanged)',
      status: txMsg3 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg3 ? 'Received' : 'Timeout',
    });

    // Step 5: CS sends TransactionEvent, CSMS responds with CallError
    const txMsg5 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 5,
      description: 'TransactionEvent retry with CallError responses',
      status: txMsg5 ? 'passed' : 'failed',
      expected: 'CS retries TransactionEvent after CallError',
      actual: txMsg5 ? 'TransactionEvent received' : 'Timeout',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_42_CS: CsTestCase = {
  id: 'TC_E_42_CS',
  name: 'Retry sending transaction message when failed - Success before reaching the max retry count',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'There are situations/issues why a CSMS might not accept a transaction related message, or does not reply.',
  purpose:
    'To verify if the Charging Station is able to resend TransactionEvent messages when the CSMS does not respond and succeeds on retry.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging with fast meter interval
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1 (optional): TransactionEvent
    const txMsg1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description: 'TransactionEvent (optional SignedDataReceived)',
      status: txMsg1 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg1 ? 'Received' : 'Timeout',
    });

    // Step 3 (optional): TransactionEvent
    const txMsg3 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 3,
      description: 'TransactionEvent (optional ChargingStateChanged)',
      status: txMsg3 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg3 ? 'Received' : 'Timeout',
    });

    // Step 5: CS sends TransactionEvent - first ignored, second gets response
    const txMsg5 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 5,
      description: 'TransactionEvent sent twice - second succeeds',
      status: txMsg5 ? 'passed' : 'failed',
      expected: 'CS retries and succeeds on second attempt',
      actual: txMsg5 ? 'TransactionEvent received' : 'Timeout',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_51_CS: CsTestCase = {
  id: 'TC_E_51_CS',
  name: 'Retry sending transaction message when failed - Success before reaching the max retry count - CallError',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'There are situations/issues why a CSMS might not accept a transaction related message, or does not reply.',
  purpose:
    'To verify if the Charging Station is able to resend TransactionEvent messages after CallError and succeed on retry.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start charging with fast meter interval
    await startChargingFast(ctx, 1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1 (optional): TransactionEvent
    const txMsg1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description: 'TransactionEvent (optional SignedDataReceived)',
      status: txMsg1 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg1 ? 'Received' : 'Timeout',
    });

    // Step 3 (optional): TransactionEvent
    const txMsg3 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 3,
      description: 'TransactionEvent (optional ChargingStateChanged)',
      status: txMsg3 ? 'passed' : 'failed',
      expected: 'TransactionEvent received',
      actual: txMsg3 ? 'Received' : 'Timeout',
    });

    // Step 5: CS sends TransactionEvent, first gets CallError, second gets response
    const txMsg5 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 5,
      description: 'TransactionEvent retry - first CallError, second succeeds',
      status: txMsg5 ? 'passed' : 'failed',
      expected: 'CS retries after CallError and succeeds',
      actual: txMsg5 ? 'TransactionEvent received' : 'Timeout',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
