// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

export const TC_B_21_CS: CsTestCase = {
  id: 'TC_B_21_CS',
  name: 'Reset Charging Station - With Ongoing Transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself with an ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism while there is an ongoing transaction (OnIdle).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Reusable State EnergyTransferStarted
    // Manual Action: plug in cable and start charging
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Drain TransactionEvent Started from the buffer
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 1: CSMS sends Reset OnIdle (should be Scheduled since transaction is ongoing)
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Scheduled',
      status: resetStatus === 'Scheduled' ? 'passed' : 'failed',
      expected: 'status = Scheduled',
      actual: `status = ${resetStatus}`,
    });

    // Step 3: Stop the transaction (Manual Action: unplug)
    await ctx.station.stopCharging(1, 'Local');
    await ctx.station.unplug(1);

    // Step 7: Station reboots after transaction ends - wait for BootNotification
    try {
      const bootPayload = await ctx.server.waitForMessage('BootNotification', 15000);
      steps.push({
        step: 7,
        description: 'Station rebooted after transaction ended',
        status: bootPayload != null ? 'passed' : 'failed',
        expected: 'BootNotification received',
        actual: bootPayload != null ? 'BootNotification received' : 'Not received',
      });
    } catch {
      steps.push({
        step: 7,
        description: 'Station rebooted after transaction ended',
        status: 'failed',
        expected: 'BootNotification received',
        actual: 'Timed out waiting for reboot',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_22_CS: CsTestCase = {
  id: 'TC_B_22_CS',
  name: 'Reset Charging Station - With Ongoing Transaction - Immediate',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself immediately with an ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: CSMS sends Reset Immediate
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    // Step 3: Station sends TransactionEvent Ended (drain Updated events first)
    try {
      let eventType = '';
      for (let i = 0; i < 10; i++) {
        const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
        eventType = txPayload['eventType'] as string;
        if (eventType === 'Ended') break;
      }
      steps.push({
        step: 3,
        description: 'TransactionEventRequest: eventType = Ended',
        status: eventType === 'Ended' ? 'passed' : 'failed',
        expected: 'eventType = Ended',
        actual: `eventType = ${eventType}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'TransactionEventRequest received',
        status: 'failed',
        expected: 'TransactionEventRequest Ended',
        actual: 'Timed out',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_41_CS: CsTestCase = {
  id: 'TC_B_41_CS',
  name: 'Reset Charging Station - With multiple ongoing transactions - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset with multiple ongoing transactions.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism while there are multiple ongoing transactions.',
  stationConfig: { evseCount: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Start transactions on EVSE 1 and EVSE 2
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: CSMS sends Reset OnIdle
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Scheduled',
      status: (resetRes['status'] as string) === 'Scheduled' ? 'passed' : 'failed',
      expected: 'status = Scheduled',
      actual: `status = ${resetRes['status'] as string}`,
    });

    // Stop all transactions
    await ctx.station.stopCharging(1, 'Local');
    await ctx.station.unplug(1);

    // Wait for station reboot
    try {
      const bootPayload = await ctx.server.waitForMessage('BootNotification', 15000);
      steps.push({
        step: 11,
        description: 'Station rebooted after all transactions ended',
        status: bootPayload != null ? 'passed' : 'failed',
        expected: 'BootNotification received',
        actual: bootPayload != null ? 'BootNotification received' : 'Not received',
      });
    } catch {
      steps.push({
        step: 11,
        description: 'Station rebooted after all transactions ended',
        status: 'failed',
        expected: 'BootNotification received',
        actual: 'Timed out',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_26_CS: CsTestCase = {
  id: 'TC_B_26_CS',
  name: 'Reset EVSE - With Ongoing Transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset an EVSE with an ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to perform the EVSE reset mechanism (OnIdle).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: CSMS sends Reset OnIdle for EVSE 1
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle', evseId: 1 });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Scheduled',
      status: (resetRes['status'] as string) === 'Scheduled' ? 'passed' : 'failed',
      expected: 'status = Scheduled',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_27_CS: CsTestCase = {
  id: 'TC_B_27_CS',
  name: 'Reset EVSE - With Ongoing Transaction - Immediate',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset an EVSE immediately with an ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to perform the EVSE reset mechanism (Immediate).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1: CSMS sends Reset Immediate for EVSE 1
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'Immediate', evseId: 1 });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    // Step 3: Station sends TransactionEvent Ended (drain Updated events first)
    try {
      let eventType = '';
      for (let i = 0; i < 10; i++) {
        const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
        eventType = txPayload['eventType'] as string;
        if (eventType === 'Ended') break;
      }
      steps.push({
        step: 3,
        description: 'TransactionEventRequest: eventType = Ended',
        status: eventType === 'Ended' ? 'passed' : 'failed',
        expected: 'eventType = Ended',
        actual: `eventType = ${eventType}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'TransactionEventRequest received',
        status: 'failed',
        expected: 'TransactionEventRequest Ended',
        actual: 'Timed out',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
