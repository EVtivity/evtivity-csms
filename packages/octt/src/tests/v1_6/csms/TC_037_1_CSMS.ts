// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import { pushSendAckStep } from '../../../csms-test-helpers.js';

export const TC_037_1_CSMS: TestCase = {
  id: 'TC_037_1_CSMS',
  name: 'Offline Start Transaction - Valid IdTag (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Start a transaction while offline with a valid idTag.',
  purpose:
    'Verify the CSMS accepts a StartTransaction sent after connectivity is restored with a valid idTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Offline transaction: send StartTransaction with past timestamp
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    const startAccepted = startTagInfo?.['status'] === 'Accepted';
    steps.push({
      step: 1,
      description: 'Send offline StartTransaction with valid idTag and expect Accepted',
      status: startAccepted ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    // StatusNotification Charging
    const resp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    pushSendAckStep(
      steps,
      2,
      'Send StatusNotification (Charging)',
      resp2,
      'StatusNotification.conf received',
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
