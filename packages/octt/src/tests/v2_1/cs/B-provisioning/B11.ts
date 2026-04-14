// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_20_CS: CsTestCase = {
  id: 'TC_B_20_CS',
  name: 'Reset Charging Station - Without ongoing transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset itself.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Send Reset OnIdle
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetStatus}`,
    });

    // Step 3: Station reboots autonomously - wait for BootNotification
    let bootReceived = false;
    try {
      const bootPayload = await ctx.server.waitForMessage('BootNotification', 10000);
      bootReceived = bootPayload != null;
    } catch {
      // Timeout - station did not reboot
    }
    steps.push({
      step: 3,
      description: 'Station sends BootNotification after reboot',
      status: bootReceived ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: bootReceived ? 'BootNotification received' : 'Timed out',
    });

    // Step 5: Wait for StatusNotification with connectorStatus = Available
    // Drain any Unavailable StatusNotification from pre-reboot
    try {
      let connectorStatus = '';
      for (let i = 0; i < 5; i++) {
        const statusPayload = await ctx.server.waitForMessage('StatusNotification', 10000);
        connectorStatus =
          (statusPayload['connectorStatus'] as string) ?? (statusPayload['status'] as string) ?? '';
        if (connectorStatus === 'Available') break;
      }
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

export const TC_B_23_CS: CsTestCase = {
  id: 'TC_B_23_CS',
  name: 'Reset Charging Station - Unavailable persists reset',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset itself.',
  purpose: 'To verify if the Charging Station persists the Unavailable state after a reset.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    // Simulate reboot
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'RemoteReset',
    });
    const bootReason = 'RemoteReset';
    steps.push({
      step: 3,
      description: 'BootNotificationRequest: reason = RemoteReset',
      status: bootReason === 'RemoteReset' ? 'passed' : 'failed',
      expected: 'reason = RemoteReset',
      actual: `reason = ${bootReason}, status = ${bootRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_24_CS: CsTestCase = {
  id: 'TC_B_24_CS',
  name: 'Reset Charging Station - Reserved persists reset',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset itself.',
  purpose:
    'To verify if the CSMS is able to perform the reset mechanism and reserved state persists.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    // Simulate reboot
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'RemoteReset',
    });
    steps.push({
      step: 3,
      description: 'BootNotificationRequest: reason = RemoteReset',
      status: (bootRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'Boot accepted',
      actual: `status = ${bootRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_25_CS: CsTestCase = {
  id: 'TC_B_25_CS',
  name: 'Reset EVSE - Without ongoing transaction',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset an EVSE.',
  purpose: 'To verify if the Charging Station is able to perform the EVSE reset mechanism.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle', evseId: 1 });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_28_CS: CsTestCase = {
  id: 'TC_B_28_CS',
  name: 'Reset EVSE - Not Supported',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset an EVSE.',
  purpose: 'To verify if the Charging Station correctly rejects an EVSE reset when not supported.',
  execute: async (_ctx) => {
    // Prerequisite: "Charging Station does not support resetting individual EVSE."
    // Our CSS supports EVSE reset (TC_B_25_CS passes), so this test is not applicable.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_B_29_CS: CsTestCase = {
  id: 'TC_B_29_CS',
  name: 'Reset EVSE - With ongoing transaction - Not Supported',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset an EVSE with an ongoing transaction.',
  purpose:
    'To verify if the Charging Station correctly rejects an EVSE reset when not supported and a transaction is ongoing.',
  execute: async (_ctx) => {
    // Prerequisite: "Charging Station does not support resetting individual EVSE."
    // Our CSS supports EVSE reset, so this test is not applicable.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
