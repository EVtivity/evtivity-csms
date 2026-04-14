// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_026_CS: CsTestCase = {
  id: 'TC_026_CS',
  name: 'Remote Start Charging Session - Rejected',
  module: '12-remote-actions-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to reject a RemoteStartTransaction.req when a transaction is already ongoing.',
  purpose:
    'To test if the Charge Point rejects a RemoteStartTransaction.req when a transaction is already ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Reusable State: Charging
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

    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'OCTT_TAG_002',
    });
    steps.push({
      step: 2,
      description: 'RemoteStartTransaction Rejected',
      status: (rsResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(rsResp['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_027_CS: CsTestCase = {
  id: 'TC_027_CS',
  name: 'Remote start transaction - connector id shall not be 0',
  module: '12-remote-actions-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to reject a RemoteStartTransaction.req on connectorId = 0.',
  purpose: 'To test if the Charge Point rejects a RemoteStartTransaction.req on connectorId = 0.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 0,
      idTag: 'OCTT_TAG_001',
    });
    steps.push({
      step: 2,
      description: 'RemoteStartTransaction Rejected for connectorId=0',
      status: (rsResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(rsResp['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_028_CS: CsTestCase = {
  id: 'TC_028_CS',
  name: 'Remote Stop Transaction - Rejected',
  module: '12-remote-actions-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to reject a RemoteStopTransaction.req when an unknown transactionId is given.',
  purpose:
    'To test if the Charge Point rejects a RemoteStopTransaction.req when an unknown transactionId is given.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
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

    const rsResp = await ctx.server.sendCommand('RemoteStopTransaction', { transactionId: 99999 });
    steps.push({
      step: 2,
      description: 'RemoteStopTransaction Rejected for unknown txId',
      status: (rsResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(rsResp['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
