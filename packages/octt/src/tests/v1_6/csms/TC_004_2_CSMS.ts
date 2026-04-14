// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_004_2_CSMS: TestCase = {
  id: 'TC_004_2_CSMS',
  name: 'Regular Charging Session - Identification First - ConnectionTimeOut (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'Connector returns to Available when connection timeout expires after authorization.',
  purpose:
    'Verify the CSMS handles StatusNotification Preparing then Available when no cable is plugged in.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Step 1: StatusNotification Preparing
    const snResp1 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    steps.push({
      step: 1,
      description: 'Send StatusNotification (Preparing)',
      status: snResp1 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp1 !== undefined ? 'Response received' : 'No response',
    });

    // Step 2: StatusNotification Available (timeout expired)
    const snResp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 2,
      description: 'Send StatusNotification (Available after timeout)',
      status: snResp2 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp2 !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
