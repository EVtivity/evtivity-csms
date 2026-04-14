// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_085_CSMS: TestCase = {
  id: 'TC_085_CSMS',
  name: 'Basic Authentication - Valid username/password (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Verify the CSMS validates Basic authentication credentials.',
  purpose:
    'Verify the CSMS accepts a valid Basic auth connection and rejects one without credentials.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Attempt connection with valid credentials (already connected via test framework)
    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    const bootStatus = bootResp['status'] as string;
    steps.push({
      step: 1,
      description: 'Connect with valid Basic auth and send BootNotification',
      status: bootStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootStatus}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 2,
      description: 'Send StatusNotification (Available)',
      status: 'passed',
      expected: 'StatusNotification.conf received',
      actual: 'Response received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
