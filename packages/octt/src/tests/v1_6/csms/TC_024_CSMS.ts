// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_024_CSMS: TestCase = {
  id: 'TC_024_CSMS',
  name: 'Start Charging Session Lock Failure (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Report a connector lock failure.',
  purpose: 'Verify the CSMS handles StatusNotification with ConnectorLockFailure errorCode.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Step 1: StatusNotification Preparing
    const snResp1 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 1,
      description: 'Send StatusNotification (Preparing)',
      status: snResp1 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp1 !== undefined ? 'Response received' : 'No response',
    });

    // Step 2: StatusNotification Faulted with ConnectorLockFailure
    const snResp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Faulted',
      errorCode: 'ConnectorLockFailure',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 2,
      description: 'Send StatusNotification (Faulted, ConnectorLockFailure)',
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
