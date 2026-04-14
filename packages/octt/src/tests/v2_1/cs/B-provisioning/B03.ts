// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_03_CS: CsTestCase = {
  id: 'TC_B_03_CS',
  name: 'Cold Boot Charging Station - Rejected',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The booting mechanism allows a Charging Station to provide some general information about the Charging Station.',
  purpose:
    'To verify whether the Charging Station is able to correctly handle a rejected BootNotification.',
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    // Use a short interval so the station retries quickly in the test
    const heartbeatInterval = 2;

    // Set handler: first BootNotification gets Rejected, second gets Accepted
    let bootCount = 0;
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification') {
        bootCount++;
        if (bootCount === 1) {
          return {
            currentTime: new Date().toISOString(),
            interval: heartbeatInterval,
            status: 'Rejected',
          };
        }
        return {
          currentTime: new Date().toISOString(),
          interval: heartbeatInterval,
          status: 'Accepted',
        };
      }
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Station boots autonomously - sends BootNotification, gets Rejected
    await ctx.station.start();
    await ctx.server.waitForConnection(5000);

    // Step 1: Validate first BootNotification got Rejected
    const bootPayload = await ctx.server.waitForMessage('BootNotification', 10000);
    steps.push({
      step: 1,
      description: 'BootNotification sent, expect Rejected response',
      status: bootCount >= 1 ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: `bootCount = ${String(bootCount)}, received = ${bootPayload != null}`,
    });

    // Step 3: Station retries BootNotification after interval, gets Accepted
    try {
      const retryBoot = await ctx.server.waitForMessage(
        'BootNotification',
        (heartbeatInterval + 5) * 1000,
      );
      steps.push({
        step: 3,
        description: 'Station retries BootNotification, expect Accepted',
        status: bootCount >= 2 ? 'passed' : 'failed',
        expected: 'Second BootNotification received',
        actual: `bootCount = ${String(bootCount)}, received = ${retryBoot != null}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Station retries BootNotification',
        status: 'failed',
        expected: 'Second BootNotification received',
        actual: 'Timed out waiting for retry',
      });
    }

    // Step 5: Wait for StatusNotification with connectorStatus = Available
    try {
      const statusPayload = await ctx.server.waitForMessage('StatusNotification', 10000);
      const connectorStatus = statusPayload['connectorStatus'] as string;
      steps.push({
        step: 5,
        description: 'StatusNotificationRequest: connectorStatus = Available',
        status: connectorStatus === 'Available' ? 'passed' : 'failed',
        expected: 'connectorStatus = Available',
        actual: `connectorStatus = ${connectorStatus}`,
      });
    } catch {
      steps.push({
        step: 5,
        description: 'StatusNotificationRequest: connectorStatus = Available',
        status: 'failed',
        expected: 'connectorStatus = Available',
        actual: 'Timed out waiting for StatusNotification',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_30_CS: CsTestCase = {
  id: 'TC_B_30_CS',
  name: 'Cold Boot Charging Station - Pending/Rejected - SecurityError',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The booting mechanism allows a Charging Station to provide some general information about the Charging Station.',
  purpose:
    'To verify whether the Charging Station is able to handle unauthorized messages from the CSMS by responding with SecurityError.',
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Set handler: always respond Rejected to BootNotification
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification') {
        return {
          currentTime: new Date().toISOString(),
          interval: 300,
          status: 'Rejected',
        };
      }
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Station boots autonomously - sends BootNotification, gets Rejected
    await ctx.station.start();
    await ctx.server.waitForConnection(5000);

    // Step 1: Validate BootNotification got Rejected
    const bootPayload = await ctx.server.waitForMessage('BootNotification', 10000);
    steps.push({
      step: 1,
      description: 'BootNotification sent, expect Rejected response',
      status: bootPayload != null ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: `received = ${bootPayload != null}`,
    });

    // Step 3: CSMS sends GetBaseReport - station should respond with CALLERROR SecurityError
    try {
      await ctx.server.sendCommand('GetBaseReport', {
        requestId: 1,
        reportBase: 'FullInventory',
      });
      // If we get a normal response, the station did not reject with SecurityError
      steps.push({
        step: 4,
        description: 'Station responds with CALLERROR SecurityError',
        status: 'failed',
        expected: 'CALLERROR SecurityError',
        actual: 'Normal response received (station did not reject)',
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isSecurityError = errMsg.includes('SecurityError');
      steps.push({
        step: 4,
        description: 'Station responds with CALLERROR SecurityError',
        status: isSecurityError ? 'passed' : 'failed',
        expected: 'CALLERROR SecurityError',
        actual: errMsg,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
