// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_07_CSMS: TestCase = {
  id: 'TC_B_07_CSMS',
  name: 'Get Variables - multiple values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Get the value of two of the required variables of OCPPCommCtrlr.',
  purpose: 'To test getting multiple values using GetVariablesRequest for required variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedGetVariables = false;
    let hasOfflineThreshold = false;
    let hasAuthorizeRemoteStart = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetVariables') {
          receivedGetVariables = true;
          const getVariableData = payload['getVariableData'] as Record<string, unknown>[];
          if (Array.isArray(getVariableData)) {
            for (const item of getVariableData) {
              const variable = item['variable'] as Record<string, unknown> | undefined;
              const component = item['component'] as Record<string, unknown> | undefined;
              if (variable != null && component != null) {
                if (
                  variable['name'] === 'OfflineThreshold' &&
                  component['name'] === 'OCPPCommCtrlr'
                ) {
                  hasOfflineThreshold = true;
                }
                if (
                  variable['name'] === 'AuthorizeRemoteStart' &&
                  component['name'] === 'AuthCtrlr'
                ) {
                  hasAuthorizeRemoteStart = true;
                }
              }
            }
          }
          return {
            getVariableResult: getVariableData.map((item: Record<string, unknown>) => ({
              attributeStatus: 'Accepted',
              attributeValue: '30',
              component: (item as Record<string, unknown>)['component'],
              variable: (item as Record<string, unknown>)['variable'],
            })),
          };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetVariables', {
        stationId: ctx.stationId,
        getVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'OfflineThreshold' },
          },
          {
            component: { name: 'AuthCtrlr' },
            variable: { name: 'AuthorizeRemoteStart' },
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetVariablesRequest',
      status: receivedGetVariables
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'GetVariablesRequest received',
      actual: receivedGetVariables
        ? 'GetVariablesRequest received'
        : 'No GetVariablesRequest received',
    });

    steps.push({
      step: 2,
      description: 'Request includes OCPPCommCtrlr.OfflineThreshold',
      status: hasOfflineThreshold
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'OCPPCommCtrlr.OfflineThreshold requested',
      actual: hasOfflineThreshold ? 'Present' : 'Missing',
    });

    steps.push({
      step: 3,
      description: 'Request includes AuthCtrlr.AuthorizeRemoteStart',
      status: hasAuthorizeRemoteStart
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'AuthCtrlr.AuthorizeRemoteStart requested',
      actual: hasAuthorizeRemoteStart ? 'Present' : 'Missing',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
