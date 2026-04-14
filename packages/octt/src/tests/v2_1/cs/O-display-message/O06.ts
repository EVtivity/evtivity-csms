// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_O_12_CS: CsTestCase = {
  id: 'TC_O_12_CS',
  name: 'Set Display Message - Replace DisplayMessage',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS replaces an existing display message with a new one using the same ID.',
  purpose: 'To verify if the Charging Station replaces the display message.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 4001,
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Replaced message content' },
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
