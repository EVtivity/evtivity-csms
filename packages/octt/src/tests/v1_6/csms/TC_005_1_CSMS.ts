// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_005_1_CSMS: TestCase = {
  id: 'TC_005_1_CSMS',
  name: 'EV Side Disconnected - StopTransactionOnEVSideDisconnect (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Stop the transaction when the cable is disconnected at EV side.',
  purpose:
    'Verify the CSMS handles StatusNotification SuspendedEV, StopTransaction EVDisconnected, and status transitions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Set up a charging session
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    await ctx.client.sendCall('Authorize', { idTag });
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const transactionId = startResp['transactionId'] as number;
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    // Step 1: StatusNotification SuspendedEV (cable disconnected at EV side)
    const snResp1 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'SuspendedEV',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 1,
      description: 'Send StatusNotification (SuspendedEV)',
      status: snResp1 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp1 !== undefined ? 'Response received' : 'No response',
    });

    // Step 2: StopTransaction with reason EVDisconnected
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 1000,
      timestamp: new Date().toISOString(),
      reason: 'EVDisconnected',
    });
    steps.push({
      step: 2,
      description: 'Send StopTransaction (reason: EVDisconnected)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // Step 3: StatusNotification Finishing
    const snResp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Finishing)',
      status: snResp2 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp2 !== undefined ? 'Response received' : 'No response',
    });

    // Step 4: StatusNotification Available (cable unplugged from CP)
    const snResp3 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Available)',
      status: snResp3 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp3 !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
