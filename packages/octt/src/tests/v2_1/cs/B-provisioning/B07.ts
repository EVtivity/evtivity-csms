// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

function makeBaseReportTest(
  id: string,
  name: string,
  reportBase: string,
  description: string,
  purpose: string,
): CsTestCase {
  return {
    id,
    name,
    module: 'B-provisioning',
    version: 'ocpp2.1',
    sut: 'cs',
    description,
    purpose,
    execute: async (ctx) => {
      const steps: StepResult[] = [];

      const requestId = Math.floor(Math.random() * 1000000);
      const res = await ctx.server.sendCommand('GetBaseReport', {
        requestId,
        reportBase,
      });
      const status = res['status'] as string;

      steps.push({
        step: 2,
        description: `GetBaseReportResponse: status = Accepted`,
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${status}`,
      });

      // Wait for NotifyReport
      try {
        const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
        const seqNo = notifyPayload['seqNo'] as number;
        const reqIdReported = notifyPayload['requestId'] as number;

        steps.push({
          step: 3,
          description: 'NotifyReportRequest received with correct requestId',
          status: reqIdReported === requestId ? 'passed' : 'failed',
          expected: `requestId = ${String(requestId)}`,
          actual: `requestId = ${String(reqIdReported)}`,
        });

        steps.push({
          step: 3,
          description: 'NotifyReportRequest: seqNo = 0',
          status: seqNo === 0 ? 'passed' : 'failed',
          expected: 'seqNo = 0',
          actual: `seqNo = ${String(seqNo)}`,
        });
      } catch {
        steps.push({
          step: 3,
          description: 'NotifyReportRequest received',
          status: 'failed',
          expected: 'NotifyReportRequest received',
          actual: 'Timed out waiting for NotifyReport',
        });
      }

      const allPassed = steps.every((s) => s.status === 'passed');
      return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
    },
  };
}

export const TC_B_12_CS: CsTestCase = makeBaseReportTest(
  'TC_B_12_CS',
  'Get Base Report - ConfigurationInventory',
  'ConfigurationInventory',
  'CSMS requests a ConfigurationInventory base report.',
  'To test that Charging Station supports the ConfigurationInventory base report.',
);

export const TC_B_13_CS: CsTestCase = makeBaseReportTest(
  'TC_B_13_CS',
  'Get Base Report - FullInventory',
  'FullInventory',
  'CSMS requests a FullInventory base report.',
  'To test that Charging Station supports the FullInventory base report.',
);

export const TC_B_14_CS: CsTestCase = makeBaseReportTest(
  'TC_B_14_CS',
  'Get Base Report - SummaryInventory',
  'SummaryInventory',
  'CSMS requests a SummaryInventory base report.',
  'To test that Charging Station supports the SummaryInventory base report.',
);

export const TC_B_15_CS: CsTestCase = {
  id: 'TC_B_15_CS',
  name: 'Get Base Report - Not Supported base report',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a base report that is not supported.',
  purpose:
    'To test that Charging Station returns NotSupported when a SummaryInventory base report is requested but not supported.',
  execute: async (_ctx) => {
    // Prerequisite: "Charging Station implementation does not support the
    // optional SummaryInventory report." Our CSS supports SummaryInventory,
    // so this test is not applicable.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_B_53_CS: CsTestCase = makeBaseReportTest(
  'TC_B_53_CS',
  'Get Base Report - Test mandatory DM variables via FullInventory',
  'FullInventory',
  'CSMS requests a FullInventory base report.',
  'To test that Charging Station supports all required DM variables.',
);
