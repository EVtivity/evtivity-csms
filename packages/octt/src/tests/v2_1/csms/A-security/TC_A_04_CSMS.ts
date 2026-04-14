// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_A_04_CSMS: TestCase = {
  id: 'TC_A_04_CSMS',
  name: 'TLS - server-side certificate - Valid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS uses a server-side certificate to identify itself to the Charging Station, when using security profile 2 or 3.',
  purpose:
    'To verify whether the CSMS is able to provide a valid server certificate and setup a secured WebSocket connection.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1-6: TLS handshake and WebSocket upgrade.
    // The OcppClient handles TLS setup during connect().
    // If connected, the TLS handshake succeeded and the CSMS provided a valid server certificate.
    steps.push({
      step: 1,
      description: 'TLS handshake completed and WebSocket connection upgraded successfully',
      status: ctx.client.isConnected ? 'passed' : 'failed',
      expected: 'Secured WebSocket connection established',
      actual: ctx.client.isConnected ? 'Connected' : 'Not connected',
    });

    // Step 7-8: Send BootNotification with reason PowerUp
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    const status = bootRes['status'] as string;
    steps.push({
      step: 2,
      description: 'Send BootNotificationRequest and verify response status is Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    // Step 9-10: Notify CSMS about connector state
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });
      steps.push({
        step: 3,
        description: 'Send StatusNotification (Available) and CSMS responds accordingly',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Send StatusNotification (Available) and CSMS responds accordingly',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error or rejection',
      });
    }

    // Step 4: Send NotifyEventRequest
    try {
      await ctx.client.sendCall('NotifyEvent', {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [
          {
            eventId: 1,
            timestamp: new Date().toISOString(),
            trigger: 'Delta',
            actualValue: 'Available',
            component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
            variable: { name: 'AvailabilityState' },
            eventNotificationType: 'HardWiredNotification',
          },
        ],
      });
      steps.push({
        step: 4,
        description: 'Send NotifyEventRequest and CSMS responds accordingly',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 4,
        description: 'Send NotifyEventRequest and CSMS responds accordingly',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error or rejection',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
