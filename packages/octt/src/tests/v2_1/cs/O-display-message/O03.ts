// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_O_02_CS: CsTestCase = {
  id: 'TC_O_02_CS',
  name: 'Get all Display Messages - Success',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests all installed display messages.',
  purpose: 'To verify if the Charging Station sends all requested display messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Setup: Set a display message so there is something to get
    const setupRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 5001,
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Test message for get all' },
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

    const res = await ctx.server.sendCommand('GetDisplayMessages', { requestId: 6 });
    steps.push({
      step: 1,
      description: 'GetDisplayMessagesResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });
    try {
      const notify = await ctx.server.waitForMessage('NotifyDisplayMessages', 15000);
      steps.push({
        step: 2,
        description: 'NotifyDisplayMessagesRequest received',
        status: notify != null ? 'passed' : 'failed',
        expected: 'Message received',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 2,
        description: 'NotifyDisplayMessagesRequest',
        status: 'failed',
        expected: 'Message received',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_03_CS: CsTestCase = {
  id: 'TC_O_03_CS',
  name: 'Get all Display Messages - None configured',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests display messages when none are configured.',
  purpose:
    'To verify if the Charging Station responds with Unknown when no messages are configured.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetDisplayMessages', { requestId: 7 });
    steps.push({
      step: 1,
      description: 'GetDisplayMessagesResponse Unknown',
      status: (res['status'] as string) === 'Unknown' ? 'passed' : 'failed',
      expected: 'status = Unknown',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
