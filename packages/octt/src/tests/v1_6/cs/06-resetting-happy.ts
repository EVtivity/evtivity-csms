// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_013_CS: CsTestCase = {
  id: 'TC_013_CS',
  name: 'Hard Reset Without transaction',
  module: '06-resetting-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to hard reset a Charge Point, while no transaction is active.',
  purpose:
    'To test if the Charge Point will hard reset, after being requested by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Step 1: CS sends ChangeAvailability Inoperative
    const caResp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 1,
      type: 'Inoperative',
    });
    const caStatus = caResp['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'ChangeAvailability.conf status is Accepted',
      status: caStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(caStatus)}`,
    });

    // Step 3: StatusNotification Unavailable
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StatusNotification with Unavailable',
      status: sn1Status === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 5: CS sends Reset Hard
    const resetResp = await ctx.server.sendCommand('Reset', { type: 'Hard' });
    const resetStatus = resetResp['status'] as string | undefined;
    steps.push({
      step: 6,
      description: 'Reset.conf status is Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resetStatus)}`,
    });

    // Step 7: Wait for BootNotification after reset
    const boot = await ctx.server.waitForMessage('BootNotification', 30_000);
    steps.push({
      step: 7,
      description: 'BootNotification after reset',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // Step 9: StatusNotification after reboot
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 9,
      description: 'StatusNotification after reboot',
      status: sn2 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: sn2 !== undefined ? 'Received' : 'Not received',
    });

    // Step 11: CS sends ChangeAvailability Operative
    const ca2Resp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 1,
      type: 'Operative',
    });
    const ca2Status = ca2Resp['status'] as string | undefined;
    steps.push({
      step: 12,
      description: 'ChangeAvailability Operative Accepted',
      status: ca2Status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(ca2Status)}`,
    });

    // Step 13: StatusNotification Available
    const sn3 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn3Status = sn3['status'] as string | undefined;
    steps.push({
      step: 13,
      description: 'StatusNotification with Available',
      status: sn3Status === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn3Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_014_CS: CsTestCase = {
  id: 'TC_014_CS',
  name: 'Soft Reset Without Transaction',
  module: '06-resetting-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to soft reset a Charge Point, while no transaction is active.',
  purpose:
    'To test if the Charge Point will soft reset, after being requested by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const caResp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 1,
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

    const resetResp = await ctx.server.sendCommand('Reset', { type: 'Soft' });
    steps.push({
      step: 6,
      description: 'Reset Soft Accepted',
      status: (resetResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resetResp['status'])}`,
    });

    // BootNotification is optional for soft reset
    try {
      await ctx.server.waitForMessage('BootNotification', 15_000);
    } catch {
      /* optional */
    }

    // Wait for StatusNotification post-reset
    try {
      await ctx.server.waitForMessage('StatusNotification', 10_000);
    } catch {
      /* may not be sent if no boot */
    }

    const ca2Resp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 1,
      type: 'Operative',
    });
    steps.push({
      step: 12,
      description: 'ChangeAvailability Operative Accepted',
      status: (ca2Resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(ca2Resp['status'])}`,
    });

    const sn3 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 13,
      description: 'StatusNotification Available',
      status: (sn3['status'] as string) === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn3['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_015_CS: CsTestCase = {
  id: 'TC_015_CS',
  name: 'Hard Reset With Transaction',
  module: '06-resetting-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to hard reset a Charge Point, while a transaction is active.',
  purpose:
    'To test if the Charge Point will hard reset, after being requested by the Central System.',
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
      /* may already be consumed */
    }

    // Step 1: CS sends Reset Hard
    const resetResp = await ctx.server.sendCommand('Reset', { type: 'Hard' });
    steps.push({
      step: 2,
      description: 'Reset Hard Accepted',
      status: (resetResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resetResp['status'])}`,
    });

    // Step 3: StopTransaction with reason HardReset
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StopTransaction reason HardReset',
      status: reason === 'HardReset' ? 'passed' : 'failed',
      expected: 'reason = HardReset',
      actual: `reason = ${String(reason)}`,
    });

    // Step 7: BootNotification after reset
    const boot = await ctx.server.waitForMessage('BootNotification', 30_000);
    steps.push({
      step: 7,
      description: 'BootNotification after hard reset',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_016_CS: CsTestCase = {
  id: 'TC_016_CS',
  name: 'Soft Reset With Transaction',
  module: '06-resetting-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to soft reset a Charge Point, while a transaction is active.',
  purpose:
    'To test if the Charge Point will soft reset, after being requested by the Central System.',
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
      /* may already be consumed */
    }

    const resetResp = await ctx.server.sendCommand('Reset', { type: 'Soft' });
    steps.push({
      step: 2,
      description: 'Reset Soft Accepted',
      status: (resetResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resetResp['status'])}`,
    });

    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'StopTransaction reason SoftReset',
      status: reason === 'SoftReset' ? 'passed' : 'failed',
      expected: 'reason = SoftReset',
      actual: `reason = ${String(reason)}`,
    });

    // StatusNotification Finishing
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Finishing',
      status: (sn['status'] as string) === 'Finishing' ? 'passed' : 'failed',
      expected: 'status = Finishing',
      actual: `status = ${String(sn['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
