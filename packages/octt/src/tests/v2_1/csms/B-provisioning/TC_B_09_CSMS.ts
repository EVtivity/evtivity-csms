// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_09_CSMS: TestCase = {
  id: 'TC_B_09_CSMS',
  name: 'Set Variables - single value',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Set the value of one of the required variables of OCPPCommCtrlr.',
  purpose:
    'To test setting a single value using SetVariablesRequest for one of the required variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetVariables = false;
    let requestValid = false;
    let attributeValueCorrect = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetVariables') {
          receivedSetVariables = true;
          const setVariableData = payload['setVariableData'] as Record<string, unknown>[];
          if (Array.isArray(setVariableData) && setVariableData.length >= 1) {
            const item = setVariableData[0] as Record<string, unknown>;
            const variable = item['variable'] as Record<string, unknown> | undefined;
            const component = item['component'] as Record<string, unknown> | undefined;
            const attributeType = item['attributeType'] as string | undefined;
            if (
              variable != null &&
              component != null &&
              variable['name'] === 'OfflineThreshold' &&
              component['name'] === 'OCPPCommCtrlr' &&
              (attributeType == null || attributeType === 'Actual')
            ) {
              requestValid = true;
            }
            if (item['attributeValue'] === '123') {
              attributeValueCorrect = true;
            }
          }
          return {
            setVariableResult: setVariableData.map((item: Record<string, unknown>) => ({
              attributeStatus: 'Accepted',
              component: (item as Record<string, unknown>)['component'],
              variable: (item as Record<string, unknown>)['variable'],
            })),
          };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetVariables', {
        stationId: ctx.stationId,
        setVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'OfflineThreshold' },
            attributeValue: '123',
            attributeType: 'Actual',
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetVariablesRequest',
      status: receivedSetVariables
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'SetVariablesRequest received',
      actual: receivedSetVariables
        ? 'SetVariablesRequest received'
        : 'No SetVariablesRequest received',
    });

    steps.push({
      step: 2,
      description:
        'Request targets OCPPCommCtrlr.OfflineThreshold with Actual or absent attributeType',
      status: requestValid ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'variable.name = OfflineThreshold, component.name = OCPPCommCtrlr',
      actual: requestValid ? 'Correct target' : 'Incorrect or missing target',
    });

    steps.push({
      step: 3,
      description: 'attributeValue is 123',
      status: attributeValueCorrect
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'attributeValue = 123',
      actual: attributeValueCorrect ? 'attributeValue = 123' : 'Incorrect attributeValue',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
