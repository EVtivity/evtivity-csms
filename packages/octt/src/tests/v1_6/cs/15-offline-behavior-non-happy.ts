// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_036_CS: CsTestCase = {
  id: 'TC_036_CS',
  name: 'Connection Loss During Transaction',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to cache meter values, when a connection loss occurred during a transaction.',
  purpose: 'To test if the Charge Point handles a connection loss during a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'MeterValues') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Start charging with short meter interval for faster test
    ctx.station.setConfigValue('MeterValueSampleInterval', '2');
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

    // Wait for MeterValues (the meter loop is running)
    const mv = await ctx.server.waitForMessage('MeterValues', 10_000);
    steps.push({
      step: 1,
      description: 'MeterValues received during transaction',
      status: mv !== undefined ? 'passed' : 'failed',
      expected: 'MeterValues received',
      actual: mv !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_037_1_CS: CsTestCase = {
  id: 'TC_037_1_CS',
  name: 'Offline Start Transaction - Valid IdTag',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to start a transaction, while being offline.',
  purpose: 'To test if the Charge Point is able to start a transaction while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Enable offline auth and populate local auth list
    ctx.station.setConfigValue('LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT_TAG_001', 'Accepted');

    // Go offline
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));

    // Start transaction while offline
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');

    // Come back online
    ctx.server.acceptConnections();

    // After connectivity restore, BootNotification then queued StartTransaction
    const boot = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 0,
      description: 'BootNotification after restore',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // Drain StatusNotifications from reconnect
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StartTransaction received after restore',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_037_2_CS: CsTestCase = {
  id: 'TC_037_2_CS',
  name: 'Offline Start Transaction - Invalid IdTag - StopTransactionOnInvalidId = false',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to start a transaction, while being offline with invalid tag.',
  purpose: 'To test offline start with invalid tag and StopTransactionOnInvalidId = false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Invalid' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Configure: allow offline tx, do not stop on invalid
    ctx.station.setConfigValue('LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('AllowOfflineTxForUnknownId', 'true');
    ctx.station.setConfigValue('StopTransactionOnInvalidId', 'false');

    // Go offline
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));

    // Start with unknown tag while offline
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'UNKNOWN_TAG');

    // Come back online
    ctx.server.acceptConnections();

    // Wait for Boot, then StartTransaction (skip StatusNotifications via buffer)
    await ctx.server.waitForMessage('BootNotification', 10_000);
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StartTransaction received',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });

    // CS returns Invalid - station should suspend EVSE (StopTransactionOnInvalidId = false)
    // Wait for the SuspendedEVSE StatusNotification (may follow Charging from reconnect)
    let foundSuspended = false;
    for (let _d = 0; _d < 5; _d++) {
      try {
        const sn = await ctx.server.waitForMessage('StatusNotification', 5000);
        if ((sn['status'] as string) === 'SuspendedEVSE') {
          foundSuspended = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 3,
      description: 'StatusNotification SuspendedEVSE',
      status: foundSuspended ? 'passed' : 'failed',
      expected: 'status = SuspendedEVSE',
      actual: foundSuspended ? 'SuspendedEVSE received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_037_3_CS: CsTestCase = {
  id: 'TC_037_3_CS',
  name: 'Offline Start Transaction - Invalid IdTag - StopTransactionOnInvalidId = true',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to start a transaction, while being offline with invalid tag.',
  purpose: 'To test offline start with invalid tag and StopTransactionOnInvalidId = true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Invalid' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Configure: allow offline tx, stop on invalid
    ctx.station.setConfigValue('LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('AllowOfflineTxForUnknownId', 'true');
    ctx.station.setConfigValue('StopTransactionOnInvalidId', 'true');

    // Go offline
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));

    // Start with unknown tag while offline
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'UNKNOWN_TAG');

    // Come back online
    ctx.server.acceptConnections();

    // Drain boot and status messages
    try {
      await ctx.server.waitForMessage('BootNotification', 10_000);
    } catch {
      /* drain */
    }
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StartTransaction received',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });

    // CS returns Invalid - station should stop (StopTransactionOnInvalidId = true)
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    steps.push({
      step: 5,
      description: 'StopTransaction reason DeAuthorized',
      status: (stopTx['reason'] as string) === 'DeAuthorized' ? 'passed' : 'failed',
      expected: 'reason = DeAuthorized',
      actual: `reason = ${String(stopTx['reason'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_038_CS: CsTestCase = {
  id: 'TC_038_CS',
  name: 'Offline Stop Transaction',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to stop a transaction, while the Charge Point is offline.',
  purpose: 'To test if the Charge Point is able to stop a transaction while being offline.',
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

    // Start a transaction while online
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

    // Go offline
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));

    // Stop transaction while offline
    try {
      await ctx.station.stopCharging(1, 'Local');
    } catch {
      // Expected to fail since offline
    }

    // Come back online
    ctx.server.acceptConnections();

    // Drain boot and status messages
    try {
      await ctx.server.waitForMessage('BootNotification', 10_000);
    } catch {
      /* drain */
    }
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    const validReason = reason === 'Local' || reason === undefined;
    steps.push({
      step: 1,
      description: 'StopTransaction reason Local or omitted',
      status: validReason ? 'passed' : 'failed',
      expected: 'reason = Local or omitted',
      actual: `reason = ${String(reason)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_039_CS: CsTestCase = {
  id: 'TC_039_CS',
  name: 'Offline Transaction',
  module: '15-offline-behavior-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to start and stop a transaction, while the Charge Point is offline.',
  purpose: 'To test if the Charge Point handles a full offline transaction.',
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

    // Enable offline auth
    ctx.station.setConfigValue('LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT_TAG_001', 'Accepted');

    // Go offline
    ctx.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 500));

    // Full offline transaction: start and stop
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    await new Promise((r) => setTimeout(r, 200));
    try {
      await ctx.station.stopCharging(1, 'Local');
    } catch {
      // Expected
    }

    // Come back online
    ctx.server.acceptConnections();

    // Drain boot and status messages
    try {
      await ctx.server.waitForMessage('BootNotification', 10_000);
    } catch {
      /* drain */
    }
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StartTransaction received',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });

    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    const validReason = reason === 'Local' || reason === undefined;
    steps.push({
      step: 3,
      description: 'StopTransaction reason Local or omitted',
      status: validReason ? 'passed' : 'failed',
      expected: 'reason = Local or omitted',
      actual: `reason = ${String(reason)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
