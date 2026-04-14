// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_G_20_CSMS: Connector status Notification - Lock Failure
 *
 * Scenario:
 *   1. Test System sends NotifyEventRequest with ConnectorPlugRetentionLock Problem = true
 *   2. CSMS responds with NotifyEventResponse
 */
export const TC_G_20_CSMS: TestCase = {
  id: 'TC_G_20_CSMS',
  name: 'Connector status Notification - Lock Failure',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case describes how the EV Driver is prevented from starting a charge session at the Charging Station due to a lock failure.',
  purpose:
    'To verify if the CSMS responds on a NotifyEventRequest as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot station first
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Send NotifyEventRequest with lock failure
    const notifyRes = await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          actualValue: 'true',
          component: {
            name: 'ConnectorPlugRetentionLock',
            evse: { id: 1, connectorId: 1 },
          },
          variable: { name: 'Problem' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    });

    steps.push({
      step: 1,
      description: 'NotifyEventRequest sent with ConnectorPlugRetentionLock Problem = true',
      status: 'passed',
      expected: 'NotifyEventResponse received',
      actual: `Response keys: ${Object.keys(notifyRes).join(', ') || '(empty)'}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
