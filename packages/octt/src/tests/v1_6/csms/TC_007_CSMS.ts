// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_007_CSMS: TestCase = {
  id: 'TC_007_CSMS',
  name: 'Regular Start Charging Session - Cached Id (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'Start a transaction with an id stored in the authorization cache (no separate Authorize).',
  purpose: 'Verify the CSMS handles StartTransaction directly with a cached id.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Step 1: StatusNotification Preparing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    steps.push({
      step: 1,
      description: 'Send StatusNotification (Preparing)',
      status: 'passed',
      expected: 'StatusNotification.conf received',
      actual: 'Response received',
    });

    // Step 2: StartTransaction (no prior Authorize, using cached id)
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    const startAccepted = startTagInfo?.['status'] === 'Accepted';
    steps.push({
      step: 2,
      description: 'Send StartTransaction with cached id and expect Accepted',
      status: startAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // Step 3: StatusNotification Charging
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Charging)',
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
