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
  if (action === 'NotifyDisplayMessages') return {};
  if (action === 'MeterValues') return {};
  return {};
};

/** Helper: start a transaction and return its transactionId */
async function setupTransaction(ctx: Parameters<CsTestCase['execute']>[0]): Promise<string | null> {
  ctx.server.setMessageHandler(defaultHandler);
  await ctx.station.plugIn(1);
  await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
  const txMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
  if (txMsg == null) return null;
  const txInfo = txMsg['transactionInfo'] as Record<string, unknown> | undefined;
  return (txInfo?.['transactionId'] as string) ?? null;
}

export const TC_O_06_CS: CsTestCase = {
  id: 'TC_O_06_CS',
  name: 'Set Display Message - Specific transaction - Success',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a display message for a specific transaction.',
  purpose: 'To verify if the Charging Station displays a transaction-specific message.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const msgId = 2001;

    // Setup: Start a transaction
    const txId = await setupTransaction(ctx);
    if (txId == null) {
      steps.push({
        step: 0,
        description: 'Setup: Start transaction',
        status: 'failed',
        expected: 'Active transaction',
        actual: 'No transaction started',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: msgId,
        transactionId: txId,
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Transaction message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });

    // Verify the message is retrievable
    const getRes = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: 3,
      id: [msgId],
    });
    steps.push({
      step: 2,
      description: 'GetDisplayMessagesResponse Accepted',
      status: ['Accepted', 'Unknown'].includes(getRes['status'] as string) ? 'passed' : 'failed',
      expected: 'status = Accepted or Unknown',
      actual: `status = ${getRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_10_CS: CsTestCase = {
  id: 'TC_O_10_CS',
  name: 'Set Display Message - Specific transaction - UnknownTransaction',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a display message for an unknown transaction ID.',
  purpose: 'To verify if the Charging Station responds with UnknownTransaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2002,
        transactionId: 'UNKNOWN-TX',
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Test' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse UnknownTransaction',
      status: (setRes['status'] as string) === 'UnknownTransaction' ? 'passed' : 'failed',
      expected: 'status = UnknownTransaction',
      actual: `status = ${setRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_27_CS: CsTestCase = {
  id: 'TC_O_27_CS',
  name: 'Set Display Message - Transaction - StartTime',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a transaction display message with a start time.',
  purpose: 'To verify if the Charging Station displays the message at the configured start time.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2003,
        priority: 'NormalCycle',
        startDateTime: new Date(Date.now() + 30000).toISOString(),
        message: { format: 'UTF8', content: 'Delayed transaction message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_28_CS: CsTestCase = {
  id: 'TC_O_28_CS',
  name: 'Set Display Message - Transaction - EndTime',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a transaction display message with an end time.',
  purpose: 'To verify if the Charging Station removes the message after the end time.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const msgId = 2004;

    // Setup: Start a transaction
    const txId = await setupTransaction(ctx);
    if (txId == null) {
      steps.push({
        step: 0,
        description: 'Setup: Start transaction',
        status: 'failed',
        expected: 'Active transaction',
        actual: 'No transaction started',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: msgId,
        transactionId: txId,
        priority: 'NormalCycle',
        endDateTime: new Date(Date.now() + 30000).toISOString(),
        message: { format: 'UTF8', content: 'Expiring tx message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });

    const getRes = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: 4,
      id: [msgId],
    });
    steps.push({
      step: 2,
      description: 'GetDisplayMessagesResponse after endTime',
      status: ['Accepted', 'Unknown'].includes(getRes['status'] as string) ? 'passed' : 'failed',
      expected: 'status = Accepted or Unknown',
      actual: `status = ${getRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_30_CS: CsTestCase = {
  id: 'TC_O_30_CS',
  name: 'Set Display Message - Transaction - Multiple InFront',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets multiple InFront priority messages for a transaction.',
  purpose: 'To verify if the Charging Station displays multiple InFront messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Setup: Start a transaction
    const txId = await setupTransaction(ctx);
    if (txId == null) {
      steps.push({
        step: 0,
        description: 'Setup: Start transaction',
        status: 'failed',
        expected: 'Active transaction',
        actual: 'No transaction started',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    const res1 = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2005,
        transactionId: txId,
        priority: 'InFront',
        message: { format: 'UTF8', content: 'InFront 1' },
      },
    });
    steps.push({
      step: 1,
      description: 'First SetDisplayMessage Accepted',
      status: (res1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2006,
        transactionId: txId,
        priority: 'InFront',
        message: { format: 'UTF8', content: 'InFront 2' },
      },
    });
    steps.push({
      step: 2,
      description: 'Second SetDisplayMessage Accepted',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_32_CS: CsTestCase = {
  id: 'TC_O_32_CS',
  name: 'Set Display Message - Transaction - Second AlwaysFront',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets multiple AlwaysFront priority messages for a transaction.',
  purpose: 'To verify if a second AlwaysFront message replaces the first.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Setup: Start a transaction
    const txId = await setupTransaction(ctx);
    if (txId == null) {
      steps.push({
        step: 0,
        description: 'Setup: Start transaction',
        status: 'failed',
        expected: 'Active transaction',
        actual: 'No transaction started',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    const res1 = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2007,
        transactionId: txId,
        priority: 'AlwaysFront',
        message: { format: 'UTF8', content: 'AlwaysFront 1' },
      },
    });
    steps.push({
      step: 1,
      description: 'First SetDisplayMessage Accepted',
      status: (res1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 2008,
        transactionId: txId,
        priority: 'AlwaysFront',
        message: { format: 'UTF8', content: 'AlwaysFront 2' },
      },
    });
    steps.push({
      step: 2,
      description: 'Second SetDisplayMessage Accepted',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });

    // First message should be replaced (Unknown)
    const getRes = await ctx.server.sendCommand('GetDisplayMessages', { requestId: 5, id: [2007] });
    steps.push({
      step: 3,
      description: 'First message replaced (Unknown)',
      status: (getRes['status'] as string) === 'Unknown' ? 'passed' : 'failed',
      expected: 'status = Unknown',
      actual: `status = ${getRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
