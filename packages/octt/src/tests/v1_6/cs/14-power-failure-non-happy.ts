// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_032_1_CS: CsTestCase = {
  id: 'TC_032_1_CS',
  name: 'Power failure - stop transaction(s) before going down',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop all transactions before going down, when a power failure occurs.',
  purpose:
    'To test if the Charge Point first stops all transactions before going down, when a power failure occurs.',
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

    // Start a charging transaction
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain setup messages
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* drain */
    }

    // Trigger power failure: stops tx (sends StopTransaction), then disconnects + reconnects
    await ctx.station.simulatePowerCycle('PowerLoss');

    // Step 1: StopTransaction with reason PowerLoss (sent before disconnect)
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StopTransaction reason PowerLoss',
      status: (stopTx['reason'] as string) === 'PowerLoss' ? 'passed' : 'failed',
      expected: 'reason = PowerLoss',
      actual: `reason = ${String(stopTx['reason'])}`,
    });

    // Step 5: BootNotification after power restore (reconnect may take a few seconds)
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push({
      step: 5,
      description: 'BootNotification after power restore',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_032_2_CS: CsTestCase = {
  id: 'TC_032_2_CS',
  name: 'Power failure - stop transaction(s) after going down',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop all transactions after going down, when a power failure occurred.',
  purpose: 'To test if the Charge Point first stops all transactions after going down.',
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

    // Start a charging transaction
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain setup messages
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* drain */
    }

    // Disconnect (simulating power loss - station goes offline abruptly)
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));
    // Stop transaction while offline (queued for replay)
    try {
      await ctx.station.stopCharging(1, 'PowerLoss');
    } catch {
      // May fail since offline, but state should update
    }
    // Allow reconnection
    ctx.server.acceptConnections();

    // BootNotification after power restore
    const boot = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 1,
      description: 'BootNotification after power restore',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // StopTransaction (queued while offline, replayed after reconnect)
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    const validReason = reason === 'PowerLoss' || reason === 'Local' || reason === undefined;
    steps.push({
      step: 5,
      description: 'StopTransaction with valid reason',
      status: validReason ? 'passed' : 'failed',
      expected: 'reason = PowerLoss or Local or omitted',
      actual: `reason = ${String(reason)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_034_CS: CsTestCase = {
  id: 'TC_034_CS',
  name: 'Power Failure with Unavailable Status',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to persist the status of the connectors, when a power failure occurs.',
  purpose:
    'To test if the Charge Point persists the status of the connectors, when a power failure occurs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Set connector to Inoperative
    const caResp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 0,
      type: 'Inoperative',
    });
    steps.push({
      step: 2,
      description: 'ChangeAvailability Inoperative Accepted',
      status: (caResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(caResp['status'])}`,
    });

    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Unavailable',
      status: (sn1['status'] as string) === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${String(sn1['status'])}`,
    });

    // Simulate power cycle (disconnect and reconnect)
    await ctx.station.simulatePowerCycle();

    // BootNotification after power cycle (reconnect may take a few seconds)
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push({
      step: 5,
      description: 'BootNotification after power cycle',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // StatusNotification should still be Unavailable (persisted in evseConnectorStatus)
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 7,
      description: 'StatusNotification persisted Unavailable',
      status: (sn2['status'] as string) === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${String(sn2['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
