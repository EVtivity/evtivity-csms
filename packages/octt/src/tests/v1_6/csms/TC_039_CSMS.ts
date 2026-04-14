// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_039_CSMS: TestCase = {
  id: 'TC_039_CSMS',
  name: 'Offline Transaction (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Start and stop a transaction while offline, then send both after reconnecting.',
  purpose:
    'Verify the CSMS handles queued StartTransaction and StopTransaction after reconnection.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Queued StartTransaction
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    const transactionId = startResp['transactionId'] as number;
    steps.push({
      step: 1,
      description: 'Send queued StartTransaction and expect Accepted',
      status: startTagInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // Queued StopTransaction with reason Local
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 3000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    steps.push({
      step: 2,
      description: 'Send queued StopTransaction (reason: Local)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
