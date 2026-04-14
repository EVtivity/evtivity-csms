// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_017_1_CS: CsTestCase = {
  id: 'TC_017_1_CS',
  name: 'Unlock connector - no session (Not fixed cable)',
  module: '07-unlocking-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to unlock a connector of a Charge Point.',
  purpose:
    'To test if the Charge Point unlocks the connector, when requested by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    const resp = await ctx.server.sendCommand('UnlockConnector', { connectorId: 1 });
    steps.push({
      step: 2,
      description: 'UnlockConnector Unlocked',
      status: (resp['status'] as string) === 'Unlocked' ? 'passed' : 'failed',
      expected: 'status = Unlocked',
      actual: `status = ${String(resp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_017_2_CS: CsTestCase = {
  id: 'TC_017_2_CS',
  name: 'Unlock connector - no session (Fixed cable)',
  module: '07-unlocking-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario describes how the Charge Point should react to UnlockConnector with fixed cable.',
  purpose: 'To test if the Charge Point reports NotSupported for fixed cable.',
  // Prerequisite: Station has fixed cable. CSS simulates removable cables.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_018_1_CS: CsTestCase = {
  id: 'TC_018_1_CS',
  name: 'Unlock Connector - With Charging Session (Not fixed cable)',
  module: '07-unlocking-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to unlock a connector while a transaction is ongoing.',
  purpose:
    'To test if the Charge Point unlocks the connector, when requested by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }

    const resp = await ctx.server.sendCommand('UnlockConnector', { connectorId: 1 });
    steps.push({
      step: 2,
      description: 'UnlockConnector Unlocked',
      status: (resp['status'] as string) === 'Unlocked' ? 'passed' : 'failed',
      expected: 'status = Unlocked',
      actual: `status = ${String(resp['status'])}`,
    });

    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    steps.push({
      step: 3,
      description: 'StopTransaction reason UnlockCommand',
      status: (stopTx['reason'] as string) === 'UnlockCommand' ? 'passed' : 'failed',
      expected: 'reason = UnlockCommand',
      actual: `reason = ${String(stopTx['reason'])}`,
    });

    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Finishing',
      status: (sn1['status'] as string) === 'Finishing' ? 'passed' : 'failed',
      expected: 'status = Finishing',
      actual: `status = ${String(sn1['status'])}`,
    });

    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 7,
      description: 'StatusNotification Available',
      status: (sn2['status'] as string) === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn2['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_018_2_CS: CsTestCase = {
  id: 'TC_018_2_CS',
  name: 'Unlock Connector - With Charging Session (Fixed cable)',
  module: '07-unlocking-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario describes how the Charge Point should react to UnlockConnector with fixed cable during session.',
  purpose: 'To test if the Charge Point reports NotSupported for fixed cable during session.',
  // Prerequisite: Station has fixed cable. CSS simulates removable cables.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
