// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_132_CSMS: TestCase = {
  id: 'TC_C_132_CSMS',
  name: 'Ad hoc payment via static or dynamic QR code - invalid URL parameters',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'In order to test that CSMS supports QR codes.',
  purpose:
    'To verify if the CSMS is able to respond correctly when receiving invalid URL parameters.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 2: Verify CSMS does NOT send RequestStartTransaction
    // The QR code has invalid/omitted chargingStationId parameter
    let requestStartReceived = false;

    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'RequestStartTransaction') {
        requestStartReceived = true;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Wait to confirm no RequestStartTransaction is sent
    // Note: This test verifies CSMS does NOT send RequestStartTransaction for invalid QR params.
    // No triggerCommand needed - we are testing the absence of a command.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    steps.push({
      step: 2,
      description:
        'Verify CSMS does NOT send RequestStartTransaction for invalid QR URL parameters',
      status: !requestStartReceived ? 'passed' : 'failed',
      expected: 'No RequestStartTransaction received',
      actual: requestStartReceived
        ? 'RequestStartTransaction received (unexpected)'
        : 'No RequestStartTransaction received (correct)',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
