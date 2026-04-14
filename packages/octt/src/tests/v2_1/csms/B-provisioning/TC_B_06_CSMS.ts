// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_06_CSMS: TestCase = {
  id: 'TC_B_06_CSMS',
  name: 'Get Variables - single value',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Get the value of one of the required variables of OCPPCommCtrlr.',
  purpose:
    'To test getting a single value using GetVariablesRequest for one of the required variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot first to register the station
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Set up handler for incoming GetVariables from CSMS
    let receivedGetVariables = false;
    let requestValid = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetVariables') {
          receivedGetVariables = true;
          const getVariableData = payload['getVariableData'] as Record<string, unknown>[];
          if (Array.isArray(getVariableData) && getVariableData.length >= 1) {
            const item = getVariableData[0] as Record<string, unknown>;
            const variable = item['variable'] as Record<string, unknown> | undefined;
            const component = item['component'] as Record<string, unknown> | undefined;
            if (
              variable != null &&
              component != null &&
              variable['name'] === 'OfflineThreshold' &&
              component['name'] === 'OCPPCommCtrlr'
            ) {
              requestValid = true;
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

    // Wait for the CSMS to send GetVariables
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetVariables', {
        stationId: ctx.stationId,
        getVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'OfflineThreshold' },
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetVariablesRequest for OCPPCommCtrlr.OfflineThreshold',
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
      description: 'GetVariablesRequest contains correct variable and component',
      status: requestValid ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'variable.name = OfflineThreshold, component.name = OCPPCommCtrlr',
      actual: requestValid
        ? 'Correct variable and component'
        : 'Incorrect or missing variable/component',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
