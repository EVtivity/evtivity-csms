// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_A_07_CSMS: TestCase = {
  id: 'TC_A_07_CSMS',
  name: 'TLS - Client-side certificate - valid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station uses a client-side certificate to identify itself to the CSMS, when using security profile 3.',
  purpose:
    'To verify whether the CSMS is able to receive a client certificate provided by a Charging Station and setup a secured WebSocket connection.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1-6: TLS handshake with client certificate.
    // The OcppClient handles mTLS setup during connect() when SP3 is configured.
    // If connected, the CSMS accepted the client certificate.
    steps.push({
      step: 1,
      description: 'TLS handshake with valid client certificate accepted by CSMS',
      status: ctx.client.isConnected ? 'passed' : 'failed',
      expected: 'Secured WebSocket connection established with client certificate',
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
