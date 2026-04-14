// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_A_01_CSMS: TestCase = {
  id: 'TC_A_01_CSMS',
  name: 'Basic Authentication - Valid username/password combination',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station uses Basic authentication to authenticate itself to the CSMS, when using security profile 1 or 2.',
  purpose:
    'To verify whether the CSMS is able to validate the (valid) Basic authentication credentials provided by the Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1-2: The connection is already established with valid credentials
    // via the OcppClient (which sends Basic Auth on connect).
    // If we reach this point, the CSMS accepted the WebSocket upgrade.
    steps.push({
      step: 1,
      description: 'HTTP upgrade request with valid Basic Auth credentials accepted by CSMS',
      status: ctx.client.isConnected ? 'passed' : 'failed',
      expected: 'WebSocket connection established',
      actual: ctx.client.isConnected ? 'Connected' : 'Not connected',
    });

    // Step 3-4: Send BootNotification and validate response
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

    // Step 5-6: Notify CSMS about connector state
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

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
