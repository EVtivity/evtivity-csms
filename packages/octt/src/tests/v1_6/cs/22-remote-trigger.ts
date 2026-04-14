// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_054_CS: CsTestCase = {
  id: 'TC_054_CS',
  name: 'Trigger Message',
  module: '22-remote-trigger',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System triggers a message from the Charge Point.',
  purpose: 'Check whether the Charge Point provides the triggered message.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'MeterValues') return {};
      if (action === 'DiagnosticsStatusNotification') return {};
      if (action === 'FirmwareStatusNotification') return {};
      return {};
    });

    // Trigger Heartbeat
    const r1 = await ctx.server.sendCommand('TriggerMessage', { requestedMessage: 'Heartbeat' });
    steps.push({
      step: 6,
      description: 'TriggerMessage Heartbeat Accepted',
      status: (r1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r1['status'])}`,
    });
    const hb = await ctx.server.waitForMessage('Heartbeat', 10_000);
    steps.push({
      step: 7,
      description: 'Heartbeat received',
      status: hb !== undefined ? 'passed' : 'failed',
      expected: 'Heartbeat received',
      actual: hb !== undefined ? 'Received' : 'Not received',
    });

    // Trigger StatusNotification
    const r2 = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'StatusNotification',
      connectorId: 1,
    });
    steps.push({
      step: 10,
      description: 'TriggerMessage StatusNotification Accepted',
      status: (r2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r2['status'])}`,
    });
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 11,
      description: 'StatusNotification received',
      status: sn !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: sn !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_055_CS: CsTestCase = {
  id: 'TC_055_CS',
  name: 'Trigger Message - Rejected',
  module: '22-remote-trigger',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System triggers a message but the Charge Point rejects it.',
  purpose: 'Check whether the Charge Point is able to reject a triggered message.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Use invalid connectorId (NumberOfConnectors + 1)
    const resp = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'MeterValues',
      connectorId: 99,
    });
    steps.push({
      step: 2,
      description: 'TriggerMessage Rejected',
      status: (resp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(resp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
