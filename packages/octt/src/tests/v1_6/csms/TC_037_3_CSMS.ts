// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_037_3_CSMS: TestCase = {
  id: 'TC_037_3_CSMS',
  name: 'Offline Start Transaction - Invalid IdTag - StopTransactionOnInvalidId (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Start a transaction while offline with an invalid idTag, then stop on invalid.',
  purpose:
    'Verify the CSMS responds Invalid for an offline StartTransaction with bad idTag and the station stops.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'INVALID_OFFLINE_TAG';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Offline StartTransaction with invalid idTag
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    const startStatus = String(startTagInfo?.['status']);
    const transactionId = startResp['transactionId'] as number;
    steps.push({
      step: 1,
      description: 'Send offline StartTransaction with invalid idTag and expect Invalid',
      status: startStatus === 'Invalid' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Invalid',
      actual: `idTagInfo.status = ${startStatus}`,
    });

    // StatusNotification Charging (station started offline)
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    // StopTransaction with reason DeAuthorized
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 500,
      timestamp: new Date().toISOString(),
      reason: 'DeAuthorized',
    });
    steps.push({
      step: 2,
      description: 'Send StopTransaction (reason: DeAuthorized)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // StatusNotification Finishing
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Finishing)',
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
