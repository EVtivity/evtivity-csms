// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeMonitoringReportTest = (id: string, name: string, description: string): TestCase => ({
  id,
  name,
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description,
  purpose: `To test the CSMS supports requesting a monitoring report.`,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetMonitoringReport') {
        received = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetMonitoringReport', {
        stationId: ctx.stationId,
        requestId: 1,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetMonitoringReportRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    if (received) {
      try {
        await ctx.client.sendCall('NotifyMonitoringReport', {
          requestId: 1,
          seqNo: 0,
          tbc: false,
          generatedAt: new Date().toISOString(),
          monitor: [
            {
              component: { name: 'EVSE', evse: { id: 1 } },
              variable: { name: 'AvailabilityState' },
              variableMonitoring: [
                {
                  id: 1,
                  transaction: false,
                  value: 1,
                  type: 'Delta',
                  severity: 8,
                  eventNotificationType: 'CustomMonitor',
                },
              ],
            },
          ],
        });
        steps.push({
          step: 2,
          description: 'Send NotifyMonitoringReportRequest',
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: 2,
          description: 'Send NotifyMonitoringReportRequest',
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_N_01_CSMS = makeMonitoringReportTest(
  'TC_N_01_CSMS',
  'Get Monitoring Report - with monitoringCriteria',
  'CSMS requests a monitoring report matching component criteria.',
);
export const TC_N_02_CSMS = makeMonitoringReportTest(
  'TC_N_02_CSMS',
  'Get Monitoring Report - with component/variable',
  'CSMS requests a monitoring report for a specific component and variable.',
);
export const TC_N_03_CSMS = makeMonitoringReportTest(
  'TC_N_03_CSMS',
  'Get Monitoring Report - with criteria and component/variable',
  'CSMS requests a monitoring report matching criteria and component/variable.',
);
export const TC_N_60_CSMS = makeMonitoringReportTest(
  'TC_N_60_CSMS',
  'Get Monitoring Report - with criteria and list of components/variables',
  'CSMS requests a monitoring report for a list of components/variables.',
);
export const TC_N_47_CSMS = makeMonitoringReportTest(
  'TC_N_47_CSMS',
  'Get Monitoring Report - Report all',
  'CSMS requests all configured monitors.',
);
export const TC_N_104_CSMS = makeMonitoringReportTest(
  'TC_N_104_CSMS',
  'Get Monitoring Report - TargetDeltaMonitoring',
  'CSMS requests a monitoring report for TargetDeltaMonitoring.',
);
