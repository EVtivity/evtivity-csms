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

export const TC_G_03_CS: CsTestCase = {
  id: 'TC_G_03_CS',
  name: 'Change Availability EVSE - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Execute Reusable State Unavailable for configured evseId
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 1,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Wait for StatusNotificationRequest with Unavailable
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

export const TC_G_04_CS: CsTestCase = {
  id: 'TC_G_04_CS',
  name: 'Change Availability EVSE - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Step 1-2: Send ChangeAvailabilityRequest Operative
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: evseId },
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Step 3: Wait for StatusNotificationRequest Available
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    steps.push({
      step: 3,
      description:
        'StatusNotificationRequest - connectorStatus must be Available, evseId must match',
      status: connectorStatus === 'Available' && statusEvseId === evseId ? 'passed' : 'failed',
      expected: `connectorStatus = Available, evseId = ${String(evseId)}`,
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_07_CS: CsTestCase = {
  id: 'TC_G_07_CS',
  name: 'Change Availability Connector - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    // Execute Reusable State Unavailable for configured connectorId
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId, connectorId },
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
    const statusConnStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 2,
      description: 'StatusNotificationRequest - connectorStatus must be Unavailable',
      status: statusConnStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${statusConnStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_08_CS: CsTestCase = {
  id: 'TC_G_08_CS',
  name: 'Change Availability Connector - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability mechanism as described at the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: evseId, connectorId },
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
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    const statusConnId = (statusMsg as Record<string, unknown>)['connectorId'] as number;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Available',
      status:
        connectorStatus === 'Available' && statusEvseId === evseId && statusConnId === connectorId
          ? 'passed'
          : 'failed',
      expected: `connectorStatus = Available, evseId = ${String(evseId)}, connectorId = ${String(connectorId)}`,
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}, connectorId = ${String(statusConnId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_09_CS: CsTestCase = {
  id: 'TC_G_09_CS',
  name: 'Change Availability EVSE - Operative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from Operative to Operative.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: evseId },
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

export const TC_G_10_CS: CsTestCase = {
  id: 'TC_G_10_CS',
  name: 'Change Availability EVSE - Inoperative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from inoperative to inoperative.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
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

export const TC_G_11_CS: CsTestCase = {
  id: 'TC_G_11_CS',
  name: 'Change Availability EVSE - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability during a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Start a transaction so the EVSE has an ongoing session
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Send Inoperative during active transaction
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
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
    await ctx.station.stopCharging(evseId, 'Local');

    // Wait for StatusNotificationRequest Unavailable after transaction ends
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 4,
      description:
        'StatusNotificationRequest - connectorStatus must be Unavailable after transaction ends',
      status: connectorStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_15_CS: CsTestCase = {
  id: 'TC_G_15_CS',
  name: 'Change Availability Connector - Operative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from Operative to Operative of a connector.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: evseId, connectorId },
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

export const TC_G_16_CS: CsTestCase = {
  id: 'TC_G_16_CS',
  name: 'Change Availability Connector - Inoperative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability from inoperative to inoperative of a connector.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId, connectorId },
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

export const TC_G_17_CS: CsTestCase = {
  id: 'TC_G_17_CS',
  name: 'Change Availability Connector - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station is able to perform the change availability during a transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    // Start a transaction so the connector has an ongoing session
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);
    // Drain leftover StatusNotifications from start sequence
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 200);
      } catch {
        break;
      }
    }

    // Send Inoperative for connector during active transaction
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId, connectorId },
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
    await ctx.station.stopCharging(evseId, 'Local');

    // Wait for StatusNotificationRequest Unavailable after transaction ends
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusConnStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 7,
      description:
        'StatusNotificationRequest - connectorStatus must be Unavailable after transaction ends',
      status: statusConnStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${statusConnStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_18_CS: CsTestCase = {
  id: 'TC_G_18_CS',
  name: 'Change Availability EVSE - state persists across reboot',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs.',
  purpose:
    'To verify if the Charging Station sets the availability persistent across reboot/power loss.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Step 1-2: Send ChangeAvailabilityRequest Inoperative
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    // Step 3: Wait for StatusNotificationRequest Unavailable for configured evseId
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    steps.push({
      step: 3,
      description:
        'StatusNotificationRequest - connectorStatus must be Unavailable for configured evseId',
      status: connectorStatus === 'Unavailable' && statusEvseId === evseId ? 'passed' : 'failed',
      expected: `connectorStatus = Unavailable, evseId = ${String(evseId)}`,
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_19_CS: CsTestCase = {
  id: 'TC_G_19_CS',
  name: 'Change Availability Connector - state persists across reboot',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors.',
  purpose:
    'To verify if the Charging Station sets the availability persistent across reboot/power loss.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    setupHandler(ctx);

    // Step 1-2: Set connector to Inoperative
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId, connectorId },
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

    // Step 4: After reboot, wait for StatusNotificationRequest with Unavailable
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
        'StatusNotificationRequest - connectorStatus must be Unavailable for configured evseId/connectorId after reboot',
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
