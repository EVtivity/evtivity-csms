// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_030_CS: CsTestCase = {
  id: 'TC_030_CS',
  name: 'Unlock Connector - Unlock Failure',
  module: '13-unlocking-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to report a connector lock failure.',
  purpose: 'To test if the Charge Point is able to report a connector lock failure.',
  // Prerequisite: Station has physical lock mechanism that can fail. CSS doesn't simulate lock failure.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_031_CS: CsTestCase = {
  id: 'TC_031_CS',
  name: 'Unlock Connector - Unknown Connector',
  module: '13-unlocking-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to reject an UnlockConnector.req when an unknown connectorId is given.',
  purpose:
    'To test if the Charge Point reacts correctly when receiving an UnlockConnector.req with an unknown connectorId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const resp = await ctx.server.sendCommand('UnlockConnector', { connectorId: 99 });
    steps.push({
      step: 2,
      description: 'UnlockConnector NotSupported for unknown connector',
      status: (resp['status'] as string) === 'NotSupported' ? 'passed' : 'failed',
      expected: 'status = NotSupported',
      actual: `status = ${String(resp['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
