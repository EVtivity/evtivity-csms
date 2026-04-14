// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_01_CSMS: TestCase = {
  id: 'TC_B_01_CSMS',
  name: 'Cold Boot Charging Station - Accepted',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'Verify the CSMS correctly handles a BootNotification from a charging station performing a cold boot.',
  purpose: 'The CSMS must respond with Accepted status and provide a heartbeat interval.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Send BootNotification
    const response = await ctx.client.sendCall('BootNotification', {
      chargingStation: {
        model: 'OCTT-Virtual',
        vendorName: 'OCTT',
      },
      reason: 'PowerUp',
    });

    const status = response['status'] as string;
    steps.push({
      step: 1,
      description: 'Send BootNotification with reason PowerUp',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    // Step 2: Verify heartbeat interval is present and positive
    const interval = response['interval'] as number;
    const intervalValid = typeof interval === 'number' && interval > 0;
    steps.push({
      step: 2,
      description: 'Response contains positive heartbeat interval',
      status: intervalValid ? 'passed' : 'failed',
      expected: 'interval > 0',
      actual: `interval = ${String(interval)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return {
      status: allPassed ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
