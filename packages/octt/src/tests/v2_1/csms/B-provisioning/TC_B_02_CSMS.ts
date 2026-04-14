// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_02_CSMS: TestCase = {
  id: 'TC_B_02_CSMS',
  name: 'Cold Boot Charging Station - Pending',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The booting mechanism allows a Charging Station to provide some general information about the Charging Station to the CSMS.',
  purpose:
    'To verify whether the CSMS is able to accept the communications of a registered Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Send BootNotification with reason PowerUp
    const response = await ctx.client.sendCall('BootNotification', {
      chargingStation: {
        model: 'OCTT-Virtual',
        vendorName: 'OCTT',
      },
      reason: 'PowerUp',
    });

    const status = response['status'] as string;
    const statusValid = status === 'Pending' || status === 'Accepted';
    steps.push({
      step: 1,
      description: 'Send BootNotification with reason PowerUp and verify response status',
      status: statusValid ? 'passed' : 'failed',
      expected: 'status = Pending or Accepted',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return {
      status: allPassed ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
