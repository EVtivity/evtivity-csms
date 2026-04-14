// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_08_CSMS: TestCase = {
  id: 'TC_B_08_CSMS',
  name: 'Get Variables - limit to maximum number of values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Do not request more variables than supported by MaxItemsPerMessageGetVariables.',
  purpose:
    'To test that CSMS does not request more variables than the Charging Station reported to support.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const maxItems = 4;

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Report DeviceDataCtrlr and AuthCtrlr variables via NotifyReport
    await ctx.client.sendCall('NotifyReport', {
      requestId: 0,
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      reportData: [
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'ItemsPerMessage', instance: 'GetReport' },
          variableAttribute: [{ type: 'Actual', value: String(maxItems), mutability: 'ReadOnly' }],
          variableCharacteristics: {
            dataType: 'integer',
            supportsMonitoring: false,
          },
        },
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'ItemsPerMessage', instance: 'GetVariables' },
          variableAttribute: [{ type: 'Actual', value: String(maxItems), mutability: 'ReadOnly' }],
          variableCharacteristics: {
            dataType: 'integer',
            supportsMonitoring: false,
          },
        },
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'BytesPerMessage', instance: 'GetReport' },
          variableAttribute: [{ type: 'Actual', value: '4096', mutability: 'ReadOnly' }],
          variableCharacteristics: {
            dataType: 'integer',
            supportsMonitoring: false,
          },
        },
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'BytesPerMessage', instance: 'GetVariables' },
          variableAttribute: [{ type: 'Actual', value: '4096', mutability: 'ReadOnly' }],
          variableCharacteristics: {
            dataType: 'integer',
            supportsMonitoring: false,
          },
        },
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'AuthorizeRemoteStart' },
          variableAttribute: [{ type: 'Actual', value: 'true', mutability: 'ReadWrite' }],
          variableCharacteristics: {
            dataType: 'boolean',
            supportsMonitoring: false,
          },
        },
      ],
    });

    // Allow time for the event projection to store the NotifyReport configuration
    // in station_configurations before triggering GetVariables
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const receivedRequests: number[] = [];

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetVariables') {
          const getVariableData = payload['getVariableData'] as Record<string, unknown>[];
          if (Array.isArray(getVariableData)) {
            receivedRequests.push(getVariableData.length);
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

    // Wait for CSMS to send GetVariables requests (requesting 5 variables should be split)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetVariables', {
        stationId: ctx.stationId,
        getVariableData: [
          { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'OfflineThreshold' } },
          { component: { name: 'AuthCtrlr' }, variable: { name: 'AuthorizeRemoteStart' } },
          { component: { name: 'TxCtrlr' }, variable: { name: 'TxStartPoint' } },
          { component: { name: 'TxCtrlr' }, variable: { name: 'TxStopPoint' } },
          { component: { name: 'DeviceDataCtrlr' }, variable: { name: 'ItemsPerMessage' } },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const allWithinLimit = receivedRequests.every((count) => count <= maxItems);

    steps.push({
      step: 1,
      description: 'CSMS sends GetVariablesRequest(s)',
      status:
        receivedRequests.length > 0
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'At least one GetVariablesRequest received',
      actual: `Received ${String(receivedRequests.length)} request(s)`,
    });

    steps.push({
      step: 2,
      description: `Each request contains at most ${String(maxItems)} variables`,
      status: allWithinLimit
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: `Each request has <= ${String(maxItems)} items`,
      actual: `Request sizes: ${receivedRequests.map(String).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
