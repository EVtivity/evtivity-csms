// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_51_CS: CsTestCase = {
  id: 'TC_B_51_CS',
  name: 'Status change during offline period - > Offline Threshold',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'A Charging Station sends a notification to the CSMS to inform the CSMS about a Connector status change.',
  purpose:
    'To verify whether the Charging Station reports the status of all connectors after having been offline for longer than the OfflineThreshold.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: CSMS closes WebSocket connection and does not accept reconnect
    ctx.server.disconnectStation(true);

    // Wait briefly for the close to propagate
    await new Promise((r) => setTimeout(r, 500));

    steps.push({
      step: 1,
      description: 'Test System closes WebSocket connection',
      status: !ctx.server.isConnected ? 'passed' : 'failed',
      expected: 'Connection closed',
      actual: `isConnected = ${String(ctx.server.isConnected)}`,
    });

    // Step 2: Manual Action: Connect the EV and EVSE
    await ctx.station.plugIn(1);

    // Step 3: Test System accepts reconnection after threshold exceeded
    // Allow connections again and wait for station to reconnect
    await new Promise((r) => setTimeout(r, 1000));
    ctx.server.acceptConnections();

    try {
      await ctx.server.waitForConnection(15000);
      steps.push({
        step: 3,
        description: 'Station reconnected after offline threshold exceeded',
        status: ctx.server.isConnected ? 'passed' : 'failed',
        expected: 'Station reconnected',
        actual: `isConnected = ${String(ctx.server.isConnected)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Station reconnected after offline threshold exceeded',
        status: 'failed',
        expected: 'Station reconnected',
        actual: 'Timed out waiting for reconnection',
      });
    }

    // Step 4: Station notifies CSMS about current state of all connectors
    // Expect StatusNotification with Occupied for the plugged connector
    try {
      // Drain BootNotification from reconnect boot sequence
      await ctx.server.waitForMessage('BootNotification', 10000);

      const statusPayload = await ctx.server.waitForMessage('StatusNotification', 10000);
      const connectorStatus = statusPayload['connectorStatus'] as string;
      steps.push({
        step: 4,
        description: 'StatusNotification received: connectorStatus = Occupied',
        status: connectorStatus === 'Occupied' ? 'passed' : 'failed',
        expected: 'connectorStatus = Occupied',
        actual: `connectorStatus = ${connectorStatus}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'StatusNotification received for connectors',
        status: 'failed',
        expected: 'StatusNotification received',
        actual: 'Timed out waiting for StatusNotification',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_52_CS: CsTestCase = {
  id: 'TC_B_52_CS',
  name: 'Status change during offline period - < Offline Threshold',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'A Charging Station sends a notification to the CSMS to inform the CSMS about a Connector status change.',
  purpose:
    'To verify whether the Charging Station reports the status of connectors that received a status change after being offline for less than the OfflineThreshold.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: CSMS closes WebSocket connection
    ctx.server.disconnectStation(true);

    await new Promise((r) => setTimeout(r, 500));

    steps.push({
      step: 1,
      description: 'Test System closes WebSocket connection',
      status: !ctx.server.isConnected ? 'passed' : 'failed',
      expected: 'Connection closed',
      actual: `isConnected = ${String(ctx.server.isConnected)}`,
    });

    // Step 2: Manual Action: Connect the EV and EVSE
    await ctx.station.plugIn(1);

    // Step 3: Test System accepts reconnection (before threshold exceeded)
    // Accept immediately (short offline period)
    ctx.server.acceptConnections();

    try {
      await ctx.server.waitForConnection(15000);
      steps.push({
        step: 3,
        description: 'Station reconnected before offline threshold exceeded',
        status: ctx.server.isConnected ? 'passed' : 'failed',
        expected: 'Station reconnected',
        actual: `isConnected = ${String(ctx.server.isConnected)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Station reconnected before offline threshold exceeded',
        status: 'failed',
        expected: 'Station reconnected',
        actual: 'Timed out waiting for reconnection',
      });
    }

    // Step 4: Station notifies CSMS about the configured connector status change
    try {
      // Drain BootNotification from reconnect boot sequence
      await ctx.server.waitForMessage('BootNotification', 10000);

      const statusPayload = await ctx.server.waitForMessage('StatusNotification', 10000);
      const connectorStatus = statusPayload['connectorStatus'] as string;
      steps.push({
        step: 4,
        description: 'StatusNotification received: connectorStatus = Occupied',
        status: connectorStatus === 'Occupied' ? 'passed' : 'failed',
        expected: 'connectorStatus = Occupied',
        actual: `connectorStatus = ${connectorStatus}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'StatusNotification received for configured connector',
        status: 'failed',
        expected: 'StatusNotification received',
        actual: 'Timed out waiting for StatusNotification',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
