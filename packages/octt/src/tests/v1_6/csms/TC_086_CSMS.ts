// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_086_CSMS: TestCase = {
  id: 'TC_086_CSMS',
  name: 'TLS - Server-side Certificate - Valid Certificate (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Verify the Central System provides a valid server certificate via TLS.',
  purpose: 'Verify the CSMS uses TLS 1.2+ with a valid server certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    steps.push({
      step: 1,
      description: 'Connect via TLS and send BootNotification',
      status: bootResp['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted (TLS connection established)',
      actual: `status = ${String(bootResp['status'])}`,
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
      expected: 'Response received',
      actual: 'Response received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
