// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const createGetSpecificTest = (
  id: string,
  name: string,
  purpose: string,
  params: Record<string, unknown>,
  expectAccepted: boolean,
  setupMessage?: boolean,
): CsTestCase => ({
  id,
  name,
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: `The CSMS requests specific display messages by ${Object.keys(params).join(', ')}.`,
  purpose,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Setup: set a known display message if needed
    if (setupMessage) {
      const setupRes = await ctx.server.sendCommand('SetDisplayMessage', {
        message: {
          id: 1001,
          priority: 'NormalCycle',
          state: 'Charging',
          message: { format: 'UTF8', content: 'Test message for query' },
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
    }

    const res = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: Math.floor(Math.random() * 10000),
      ...params,
    });
    const expected = expectAccepted ? 'Accepted' : 'Unknown';
    steps.push({
      step: 1,
      description: `GetDisplayMessagesResponse ${expected}`,
      status: (res['status'] as string) === expected ? 'passed' : 'failed',
      expected: `status = ${expected}`,
      actual: `status = ${res['status']}`,
    });
    if (expectAccepted) {
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
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
});

export const TC_O_07_CS = createGetSpecificTest(
  'TC_O_07_CS',
  'Get Specific Display Message - Id',
  'To verify if the Charging Station responds to a specific ID query.',
  { id: [1001] },
  true,
  true,
);
export const TC_O_08_CS = createGetSpecificTest(
  'TC_O_08_CS',
  'Get Specific Display Message - Priority',
  'To verify if the Charging Station responds to a priority query.',
  { priority: 'NormalCycle' },
  true,
  true,
);
export const TC_O_09_CS = createGetSpecificTest(
  'TC_O_09_CS',
  'Get Specific Display Message - State',
  'To verify if the Charging Station responds to a state query.',
  { state: 'Charging' },
  true,
  true,
);
export const TC_O_11_CS = createGetSpecificTest(
  'TC_O_11_CS',
  'Get Specific Display Message - Unknown parameters',
  'To verify if the Charging Station responds Unknown for non-matching parameters.',
  { id: [99999] },
  false,
);
export const TC_O_33_CS = createGetSpecificTest(
  'TC_O_33_CS',
  'Get Specific Display Message - No messages configured',
  'To verify if the Charging Station responds Unknown when no messages exist.',
  { id: [1001] },
  false,
);
export const TC_O_34_CS = createGetSpecificTest(
  'TC_O_34_CS',
  'Get Specific Display Message - Known Id, not matching State',
  'To verify if the Charging Station responds Unknown for ID with wrong state.',
  { id: [1001], state: 'Faulted' },
  false,
  true,
);
export const TC_O_35_CS = createGetSpecificTest(
  'TC_O_35_CS',
  'Get Specific Display Message - Known Id, not matching Priority',
  'To verify if the Charging Station responds Unknown for ID with wrong priority.',
  { id: [1001], priority: 'AlwaysFront' },
  false,
  true,
);
