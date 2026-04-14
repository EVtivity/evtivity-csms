// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_088_CSMS: TestCase = {
  id: 'TC_088_CSMS',
  name: 'WebSocket Subprotocol Negotiation (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Verify the CSMS selects OCPP 1.6 as the WebSocket subprotocol.',
  purpose: 'Verify the CSMS correctly negotiates ocpp1.6 subprotocol.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // The test framework already negotiates the subprotocol on connect.
    // Verify by checking we can communicate successfully.
    const protocol = ctx.client.protocol;
    steps.push({
      step: 1,
      description: 'Verify WebSocket subprotocol is ocpp1.6',
      status: protocol === 'ocpp1.6' ? 'passed' : 'failed',
      expected: 'protocol = ocpp1.6',
      actual: `protocol = ${String(protocol)}`,
    });

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    steps.push({
      step: 2,
      description: 'Send BootNotification and verify communication works',
      status: bootResp['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootResp['status'])}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
