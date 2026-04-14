// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_10_CSMS: TestCase = {
  id: 'TC_B_10_CSMS',
  name: 'Set Variables - multiple values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Set the value of two of the required variables of OCPPCommCtrlr and AuthCtrlr.',
  purpose: 'To test setting multiple values using SetVariablesRequest for required variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetVariables = false;
    let hasOfflineThreshold = false;
    let hasAuthorizeRemoteStart = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetVariables') {
          receivedSetVariables = true;
          const setVariableData = payload['setVariableData'] as Record<string, unknown>[];
          if (Array.isArray(setVariableData)) {
            for (const item of setVariableData) {
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
          {
            component: { name: 'AuthCtrlr' },
            variable: { name: 'AuthorizeRemoteStart' },
            attributeValue: 'true',
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
      description: 'Request includes OCPPCommCtrlr.OfflineThreshold',
      status: hasOfflineThreshold
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'OCPPCommCtrlr.OfflineThreshold present',
      actual: hasOfflineThreshold ? 'Present' : 'Missing',
    });

    steps.push({
      step: 3,
      description: 'Request includes AuthCtrlr.AuthorizeRemoteStart',
      status: hasAuthorizeRemoteStart
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'AuthCtrlr.AuthorizeRemoteStart present',
      actual: hasAuthorizeRemoteStart ? 'Present' : 'Missing',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
