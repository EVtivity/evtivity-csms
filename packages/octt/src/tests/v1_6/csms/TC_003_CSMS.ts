// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_003_CSMS: TestCase = {
  id: 'TC_003_CSMS',
  name: 'Regular Charging Session - Plugin First (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'Start a charging session when the EV driver plugs in first then presents identification.',
  purpose:
    'Verify the CSMS handles StatusNotification, Authorize, StartTransaction, and StatusNotification in sequence.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    // Boot first
    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Step 1: StatusNotification Preparing (cable plugged in)
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

    // Step 2: Authorize
    const authResp = await ctx.client.sendCall('Authorize', { idTag });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    const authAccepted = authStatus?.['status'] === 'Accepted';
    steps.push({
      step: 2,
      description: 'Send Authorize and expect Accepted',
      status: authAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(authStatus?.['status'])}`,
    });

    // Step 3: StartTransaction
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    const startAccepted = startTagInfo?.['status'] === 'Accepted';
    steps.push({
      step: 3,
      description: 'Send StartTransaction and expect Accepted',
      status: startAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // Step 4: StatusNotification Charging
    const snResp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Charging)',
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
