// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_14_CSMS: TestCase = {
  id: 'TC_B_14_CSMS',
  name: 'Get Base Report - SummaryInventory',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS requests a SummaryInventory base report.',
  purpose: 'To test that CSMS supports the SummaryInventory base report.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedGetBaseReport = false;
    let reportBaseCorrect = false;
    let requestIdValid = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetBaseReport') {
          receivedGetBaseReport = true;
          const reportBase = payload['reportBase'] as string;
          const requestId = payload['requestId'] as number;
          if (reportBase === 'SummaryInventory') {
            reportBaseCorrect = true;
          }
          if (typeof requestId === 'number' && requestId >= 0) {
            requestIdValid = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetBaseReport', {
        stationId: ctx.stationId,
        requestId: 1,
        reportBase: 'SummaryInventory',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetBaseReportRequest',
      status: receivedGetBaseReport
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'GetBaseReportRequest received',
      actual: receivedGetBaseReport
        ? 'GetBaseReportRequest received'
        : 'No GetBaseReportRequest received',
    });

    steps.push({
      step: 2,
      description: 'reportBase is SummaryInventory',
      status: reportBaseCorrect
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'reportBase = SummaryInventory',
      actual: reportBaseCorrect ? 'reportBase = SummaryInventory' : 'Incorrect reportBase',
    });

    steps.push({
      step: 3,
      description: 'requestId is a non-negative integer',
      status: requestIdValid
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'requestId >= 0',
      actual: requestIdValid ? 'Valid requestId' : 'Invalid requestId',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
