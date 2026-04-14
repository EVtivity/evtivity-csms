// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_001_CS: CsTestCase = {
  id: 'TC_001_CS',
  name: 'Cold Boot Charge Point',
  module: '01-cold-boot',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to startup the Charge Point and let it register itself at the Central System.',
  purpose: 'To test if the Charge Point sends the correct messages during the boot process.',
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    let bootCount = 0;

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification') {
        bootCount++;
        if (bootCount === 1) {
          return { status: 'Rejected', currentTime: new Date().toISOString(), interval: 2 };
        }
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      }
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    await ctx.station.start();
    await ctx.server.waitForConnection(5000);

    // Step 1: First BootNotification (Rejected)
    const boot1 = await ctx.server.waitForMessage('BootNotification', 5_000);
    steps.push({
      step: 1,
      description: 'Charge Point sends BootNotification.req',
      status: boot1 != null ? 'passed' : 'failed',
      expected: 'BootNotification.req received',
      actual: boot1 != null ? 'Received' : 'Not received',
    });

    // Step 3: Second BootNotification after retry (Accepted)
    const boot2 = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 3,
      description: 'Charge Point sends BootNotification.req after rejected interval',
      status: boot2 != null ? 'passed' : 'failed',
      expected: 'BootNotification.req received after interval',
      actual: boot2 != null ? 'Received' : 'Not received',
    });

    // Step 5: StatusNotification Available
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const snStatus = sn['status'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with status Available',
      status: snStatus === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(snStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_002_CS: CsTestCase = {
  id: 'TC_002_CS',
  name: 'Cold Boot Charge Point - Pending',
  module: '01-cold-boot',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to delay the startup for a Charge Point. For example to set the correct configurations.',
  purpose:
    'To test if the Charge Point is able to retrieve and set configuration while in pending state.',
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    let bootCount = 0;

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification') {
        bootCount++;
        if (bootCount === 1) {
          return { status: 'Pending', currentTime: new Date().toISOString(), interval: 2 };
        }
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      }
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    await ctx.station.start();
    await ctx.server.waitForConnection(5000);

    // Step 1: First BootNotification (Pending)
    await ctx.server.waitForMessage('BootNotification', 5_000);

    // Step 3: Send GetConfiguration while Pending
    const getConfResp = await ctx.server.sendCommand('GetConfiguration', { key: [] });
    steps.push({
      step: 3,
      description: 'CS sends GetConfiguration.req during Pending state',
      status: getConfResp != null ? 'passed' : 'failed',
      expected: 'GetConfiguration.conf received',
      actual: getConfResp != null ? 'Response received' : 'No response',
    });

    // Step 5: Send ChangeConfiguration
    const changeResp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'MeterValueSampleInterval',
      value: '30',
    });
    const changeStatus = changeResp['status'] as string | undefined;
    steps.push({
      step: 5,
      description: 'CS sends ChangeConfiguration.req and expects Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(changeStatus)}`,
    });

    // Step 7: Second BootNotification after retry (Accepted)
    const boot2 = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 7,
      description: 'Charge Point sends BootNotification.req after Pending interval',
      status: boot2 != null ? 'passed' : 'failed',
      expected: 'BootNotification.req received',
      actual: boot2 != null ? 'Received' : 'Not received',
    });

    // Step 9: StatusNotification Available
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const snStatus = sn['status'] as string | undefined;
    steps.push({
      step: 9,
      description: 'Charge Point sends StatusNotification.req with status Available',
      status: snStatus === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(snStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
