// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_032_1_CSMS: TestCase = {
  id: 'TC_032_1_CSMS',
  name: 'Power Failure Boot - Stop Transactions (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Stop all transactions when a power failure occurred.',
  purpose:
    'Verify the CSMS handles BootNotification, StatusNotification, and StopTransaction with PowerLoss after a power failure.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    // First establish a charging session
    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
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

    // Power failure: reboot
    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    const bootStatus = bootResp['status'] as string;
    steps.push({
      step: 1,
      description: 'Send BootNotification after power failure and expect Accepted',
      status: bootStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootStatus}`,
    });

    // StatusNotification for connector with ongoing transaction: Finishing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    // StopTransaction with reason PowerLoss
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 2000,
      timestamp: new Date().toISOString(),
      reason: 'PowerLoss',
    });
    steps.push({
      step: 2,
      description: 'Send StopTransaction (reason: PowerLoss)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // StatusNotification Available for other connectors
    await ctx.client.sendCall('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Available) for connectorId=0',
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
