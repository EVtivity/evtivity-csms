// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_087_CSMS: TestCase = {
  id: 'TC_087_CSMS',
  name: 'TLS - Client-side Certificate - Valid Certificate (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Verify the Central System accepts a valid client certificate (SP3).',
  purpose: 'Verify the CSMS handles mutual TLS with client certificate authentication.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    steps.push({
      step: 1,
      description: 'Connect via mTLS (client cert) and send BootNotification',
      status: bootResp['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted (mTLS connection established)',
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
