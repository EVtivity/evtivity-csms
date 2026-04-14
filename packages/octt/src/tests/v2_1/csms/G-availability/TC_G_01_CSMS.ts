// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_G_01_CSMS: TestCase = {
  id: 'TC_G_01_CSMS',
  name: 'Status Notification',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Verify the CSMS accepts StatusNotification messages for all valid statuses.',
  purpose: 'The CSMS must acknowledge StatusNotification for each connector status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    const statuses = ['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'];

    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i];
      if (status == null) continue;
      try {
        await ctx.client.sendCall('StatusNotification', {
          timestamp: new Date().toISOString(),
          connectorStatus: status,
          evseId: 1,
          connectorId: 1,
        });
        steps.push({
          step: i + 1,
          description: `Send StatusNotification with status ${status}`,
          status: 'passed' as const,
          expected: 'Response received (empty response body)',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 1,
          description: `Send StatusNotification with status ${status}`,
          status: 'failed' as const,
          expected: 'Response received',
          actual: 'Error or rejection',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
