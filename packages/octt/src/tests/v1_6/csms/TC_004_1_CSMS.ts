// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_004_1_CSMS: TestCase = {
  id: 'TC_004_1_CSMS',
  name: 'Regular Charging Session - Identification First (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Start a charging session when the EV driver presents identification first.',
  purpose: 'Verify the CSMS handles Authorize then StartTransaction in identification-first order.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Step 1: Authorize first
    const authResp = await ctx.client.sendCall('Authorize', { idTag });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    const authAccepted = authStatus?.['status'] === 'Accepted';
    steps.push({
      step: 1,
      description: 'Send Authorize and expect Accepted',
      status: authAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(authStatus?.['status'])}`,
    });

    // Step 2: StatusNotification Preparing (cable plugged in)
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
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
      step: 2,
      description: 'Send StartTransaction and expect Accepted',
      status: startAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // Step 4: StatusNotification Charging
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
