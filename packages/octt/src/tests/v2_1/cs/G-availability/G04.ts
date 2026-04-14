// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    return {};
  });
}

export const TC_G_05_CS: CsTestCase = {
  id: 'TC_G_05_CS',
  name: 'Change Availability Charging Station - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from operative to inoperative.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Execute Reusable State Unavailable (whole station)
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 1,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Wait for StatusNotificationRequest Unavailable
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 2,
      description: 'StatusNotificationRequest - connectorStatus must be Unavailable',
      status: connectorStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_06_CS: CsTestCase = {
  id: 'TC_G_06_CS',
  name: 'Change Availability Charging Station - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from inoperative to operative.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Available',
      status: connectorStatus === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus = Available',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_12_CS: CsTestCase = {
  id: 'TC_G_12_CS',
  name: 'Change Availability Charging Station - Operative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from operative to operative.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from operative to operative.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_13_CS: CsTestCase = {
  id: 'TC_G_13_CS',
  name: 'Change Availability Charging Station - Inoperative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from inoperative to inoperative.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from Inoperative to Inoperative.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Wait for StatusNotificationRequest Unavailable
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Unavailable',
      status: connectorStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_14_CS: CsTestCase = {
  id: 'TC_G_14_CS',
  name: 'Change Availability Charging Station - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability during a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Start a transaction so the station has an ongoing session
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Send Inoperative for whole station during active transaction
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Scheduled',
      status: changeStatus === 'Scheduled' ? 'passed' : 'failed',
      expected: 'status = Scheduled',
      actual: `status = ${changeStatus}`,
    });

    // Stop the transaction so the scheduled change takes effect
    await ctx.station.stopCharging(1, 'Local');

    // Wait for StatusNotificationRequest Unavailable after transaction ends
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    const statusConnId = (statusMsg as Record<string, unknown>)['connectorId'] as number;
    steps.push({
      step: 7,
      description:
        'StatusNotificationRequest - connectorStatus must be Unavailable, evseId and connectorId not 0',
      status:
        connectorStatus === 'Unavailable' && statusEvseId !== 0 && statusConnId !== 0
          ? 'passed'
          : 'failed',
      expected: 'connectorStatus = Unavailable, evseId not 0, connectorId not 0',
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}, connectorId = ${String(statusConnId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_21_CS: CsTestCase = {
  id: 'TC_G_21_CS',
  name: 'Change Availability Charging Station - state persists across reboot',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability from inoperative.',
  purpose:
    'To verify if the Charging Station sets the availability persistent across reboot/power loss.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Step 1-2: Set station to Inoperative
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Wait for initial StatusNotification Unavailable
    await ctx.server.waitForMessage('StatusNotification', 10000);

    // Step 3: Simulate power cycle (reboot)
    await ctx.station.simulatePowerCycle();

    // Step 4: After reboot, wait for BootNotification then StatusNotification
    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push({
      step: 3,
      description: 'BootNotification received after power cycle',
      status: bootMsg != null ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: bootMsg != null ? 'BootNotification received' : 'No BootNotification',
    });

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    const statusConnId = (statusMsg as Record<string, unknown>)['connectorId'] as number;
    steps.push({
      step: 4,
      description:
        'StatusNotificationRequest - connectorStatus must be Unavailable, evseId and connectorId not 0',
      status:
        connectorStatus === 'Unavailable' && statusEvseId !== 0 && statusConnId !== 0
          ? 'passed'
          : 'failed',
      expected: 'connectorStatus = Unavailable, evseId not 0, connectorId not 0',
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}, connectorId = ${String(statusConnId)}`,
    });

    // Wait for SecurityEventNotificationRequest
    const secMsg = await ctx.server.waitForMessage('SecurityEventNotification', 10000);
    const secType = (secMsg as Record<string, unknown>)['type'] as string;
    steps.push({
      step: 6,
      description:
        'SecurityEventNotificationRequest - type must be StartupOfTheDevice or ResetOrReboot',
      status: secType === 'StartupOfTheDevice' || secType === 'ResetOrReboot' ? 'passed' : 'failed',
      expected: 'type = StartupOfTheDevice or ResetOrReboot',
      actual: `type = ${secType}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
