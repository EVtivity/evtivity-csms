// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_O_04_CS: CsTestCase = {
  id: 'TC_O_04_CS',
  name: 'Clear Display Message - Success',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears a specific display message.',
  purpose: 'To verify if the Charging Station removes the specified message.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const msgId = 3001;

    // Setup: Set a display message first
    const setupRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: msgId,
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Message to clear' },
      },
    });
    if ((setupRes['status'] as string) !== 'Accepted') {
      steps.push({
        step: 0,
        description: 'Setup: SetDisplayMessage',
        status: 'failed',
        expected: 'status = Accepted',
        actual: `status = ${setupRes['status']}`,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    const clearRes = await ctx.server.sendCommand('ClearDisplayMessage', { id: msgId });
    steps.push({
      step: 1,
      description: 'ClearDisplayMessageResponse Accepted',
      status: (clearRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${clearRes['status']}`,
    });

    const getRes = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: 10,
      id: [msgId],
    });
    steps.push({
      step: 2,
      description: 'GetDisplayMessagesResponse Unknown (cleared)',
      status: (getRes['status'] as string) === 'Unknown' ? 'passed' : 'failed',
      expected: 'status = Unknown',
      actual: `status = ${getRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_05_CS: CsTestCase = {
  id: 'TC_O_05_CS',
  name: 'Clear Display Message - Unknown Key',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS tries to clear a non-existent display message.',
  purpose: 'To verify if the Charging Station responds with Unknown for a non-existent message ID.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const clearRes = await ctx.server.sendCommand('ClearDisplayMessage', { id: 99999 });
    steps.push({
      step: 1,
      description: 'ClearDisplayMessageResponse Unknown',
      status: (clearRes['status'] as string) === 'Unknown' ? 'passed' : 'failed',
      expected: 'status = Unknown',
      actual: `status = ${clearRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
