// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_023_5_CS: CsTestCase = {
  id: 'TC_023_5_CS',
  name: 'Start remote Charging Session - Authorize invalid',
  module: '11-basic-actions-non-happy-2',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to inform the Charge Point that the EV Driver is not Authorized to start a transaction.',
  purpose:
    'To test if the Charge Point does not start a transaction after Authorization fails (remote).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Invalid' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'INVALID_TAG',
    });
    steps.push({
      step: 2,
      description: 'RemoteStartTransaction Accepted',
      status: (rsResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsResp['status'])}`,
    });

    // Plug in cable
    await ctx.station.plugIn(1);

    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Preparing',
      status: (sn['status'] as string) === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_024_CS: CsTestCase = {
  id: 'TC_024_CS',
  name: 'Start Charging Session - Lock Failure',
  module: '11-basic-actions-non-happy-2',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to report a connector lock failure.',
  purpose: 'To test if the Charge Point is able to report a connector lock failure.',
  // Prerequisite: Station has physical lock that can fail. CSS doesn't simulate lock failure.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
