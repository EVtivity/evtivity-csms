// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

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

export const TC_G_01_CS: CsTestCase = {
  id: 'TC_G_01_CS',
  name: 'Connector status Notification - Available to Occupied',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'A Charging Station sends a notification to the CSMS to inform the CSMS about a Connector status change.',
  purpose:
    'To verify whether the Charging Station is able to report that its connector is Occupied.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Execute Reusable State EVConnectedPreSession - plug in cable
    await ctx.station.plugIn(1);

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 1,
      description: 'StatusNotificationRequest - connectorStatus must be Occupied',
      status: connectorStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus = Occupied',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_G_02_CS: CsTestCase = {
  id: 'TC_G_02_CS',
  name: 'Connector status Notification - Occupied to Available',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'A Charging Station sends a notification to the CSMS to inform the CSMS about a Connector status change.',
  purpose:
    'To verify whether the Charging Station is able to report that its connector is Available.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: State is EVConnectedPreSession. Disconnect the EV.
    await ctx.station.unplug(1);

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
