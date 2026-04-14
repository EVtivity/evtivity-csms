// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_18_CSMS: TestCase = {
  id: 'TC_B_18_CSMS',
  name: 'Get Custom Report - with componentCriteria and component/variables',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS requests a report of components that match both the component criteria and a given list of component/variables.',
  purpose:
    'To test that CSMS supports requesting a report for both the component criteria and a given list of component/variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedGetReport = false;
    let firstRequestId: number | null = null;
    let firstComponentCriteria: string[] = [];
    let secondGetReport = false;
    let secondRequestId: number | null = null;
    let callCount = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetReport') {
          callCount++;
          const requestId = payload['requestId'] as number;
          const componentCriteria = payload['componentCriteria'] as string[] | undefined;

          if (callCount === 1) {
            receivedGetReport = true;
            firstRequestId = requestId;
            if (Array.isArray(componentCriteria)) {
              firstComponentCriteria = componentCriteria;
            }
            // Respond with EmptyResultSet for Problem criteria
            return { status: 'EmptyResultSet' };
          }

          if (callCount === 2) {
            secondGetReport = true;
            secondRequestId = requestId;
            // Respond with Accepted for Available criteria, then send NotifyReport
            // Use queueMicrotask to send after the response frame, guarded by isConnected
            queueMicrotask(() => {
              if (!ctx.client.isConnected) return;
              ctx.client
                .sendCall('NotifyReport', {
                  requestId,
                  generatedAt: new Date().toISOString(),
                  seqNo: 0,
                  tbc: false,
                  reportData: [
                    {
                      component: { name: 'EVSE', evse: { id: 1 } },
                      variable: { name: 'AvailabilityState' },
                      variableAttribute: [{ type: 'Actual', value: 'Available' }],
                      variableCharacteristics: {
                        dataType: 'OptionList',
                        supportsMonitoring: false,
                      },
                    },
                  ],
                })
                .catch(() => {});
            });
            return { status: 'Accepted' };
          }

          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      // First GetReport: EVSE#1 AvailabilityState + Problem criteria (expect EmptyResultSet)
      await ctx.triggerCommand('v21', 'GetReport', {
        stationId: ctx.stationId,
        requestId: 1,
        componentCriteria: ['Problem'],
        componentVariable: [
          {
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'AvailabilityState' },
          },
        ],
      });
      // Second GetReport: EVSE#1 AvailabilityState + Available criteria (expect Accepted)
      await ctx.triggerCommand('v21', 'GetReport', {
        stationId: ctx.stationId,
        requestId: 2,
        componentCriteria: ['Available'],
        componentVariable: [
          {
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'AvailabilityState' },
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends first GetReportRequest (Problem criteria)',
      status: receivedGetReport
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'GetReportRequest received',
      actual: receivedGetReport ? 'GetReportRequest received' : 'No GetReportRequest received',
    });

    steps.push({
      step: 2,
      description: 'First request has valid requestId',
      status:
        firstRequestId != null && firstRequestId >= 0
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'requestId >= 0',
      actual: `requestId = ${String(firstRequestId)}`,
    });

    steps.push({
      step: 3,
      description: 'First request includes componentCriteria',
      status:
        firstComponentCriteria.length > 0
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'componentCriteria present',
      actual: `componentCriteria = ${JSON.stringify(firstComponentCriteria)}`,
    });

    steps.push({
      step: 4,
      description: 'CSMS sends second GetReportRequest (Available criteria)',
      status: secondGetReport
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'Second GetReportRequest received',
      actual: secondGetReport
        ? `Second GetReportRequest received (requestId = ${String(secondRequestId)})`
        : 'No second GetReportRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
