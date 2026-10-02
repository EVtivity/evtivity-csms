// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase, TestContext } from '../../../../types.js';

const MAX_ITEMS = 4;

interface ReportedVariable {
  component: string;
  variable: string;
  instance?: string;
  value: string;
  dataType: 'integer' | 'boolean';
  mutability: 'ReadOnly' | 'ReadWrite';
}

// The five variables of the OCTT scenario, with the values the Test System reports.
const VARIABLES: ReportedVariable[] = [
  {
    component: 'DeviceDataCtrlr',
    variable: 'ItemsPerMessage',
    instance: 'GetReport',
    value: String(MAX_ITEMS),
    dataType: 'integer',
    mutability: 'ReadOnly',
  },
  {
    component: 'DeviceDataCtrlr',
    variable: 'ItemsPerMessage',
    instance: 'GetVariables',
    value: String(MAX_ITEMS),
    dataType: 'integer',
    mutability: 'ReadOnly',
  },
  {
    component: 'DeviceDataCtrlr',
    variable: 'BytesPerMessage',
    instance: 'GetReport',
    value: '4096',
    dataType: 'integer',
    mutability: 'ReadOnly',
  },
  {
    component: 'DeviceDataCtrlr',
    variable: 'BytesPerMessage',
    instance: 'GetVariables',
    value: '4096',
    dataType: 'integer',
    mutability: 'ReadOnly',
  },
  {
    component: 'AuthCtrlr',
    variable: 'AuthorizeRemoteStart',
    value: 'true',
    dataType: 'boolean',
    mutability: 'ReadWrite',
  },
];

function variableKey(component: string, variable: string, instance: string | undefined): string {
  return `${component}.${variable}${instance != null ? `[${instance}]` : ''}`;
}

const EXPECTED_KEYS = VARIABLES.map((v) => variableKey(v.component, v.variable, v.instance)).sort();

/**
 * Waits until the CSMS has stored the reported DeviceDataCtrlr.ItemsPerMessage
 * value. The CSMS answers NotifyReport before its event projection persists the
 * report, so requesting variables right after NotifyReport races that write.
 * Both reported ItemsPerMessage instances are MAX_ITEMS, so a stored
 * ItemsPerMessage row with that value means the limit is known. Returns false
 * after the timeout; the scenario then runs anyway and the validations judge it.
 */
export async function waitForItemsPerMessageStored(
  ctx: TestContext,
  timeoutMs = 10_000,
  pollMs = 250,
): Promise<boolean> {
  if (ctx.callApi == null || ctx.stationDbId == null) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.callApi(
      'GET',
      `/stations/${ctx.stationDbId}/variables?search=ItemsPerMessage&limit=100`,
    );
    const rows = (res.body['data'] as Record<string, unknown>[] | undefined) ?? [];
    const stored = rows.some(
      (r) =>
        r['component'] === 'DeviceDataCtrlr' &&
        r['variable'] === 'ItemsPerMessage' &&
        r['value'] === String(MAX_ITEMS),
    );
    if (stored) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

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

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Before: DeviceDataCtrlr.ItemsPerMessage[GetVariables] = 4, reported to the CSMS.
    await ctx.client.sendCall('NotifyReport', {
      requestId: 0,
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      reportData: VARIABLES.map((v) => ({
        component: { name: v.component },
        variable: { name: v.variable, ...(v.instance != null ? { instance: v.instance } : {}) },
        variableAttribute: [{ type: 'Actual', value: v.value, mutability: v.mutability }],
        variableCharacteristics: { dataType: v.dataType, supportsMonitoring: false },
      })),
    });

    await waitForItemsPerMessageStored(ctx);

    const receivedRequests: string[][] = [];

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetVariables') {
          const getVariableData = Array.isArray(payload['getVariableData'])
            ? (payload['getVariableData'] as Record<string, unknown>[])
            : [];
          const keys: string[] = [];
          const getVariableResult = getVariableData.map((item) => {
            const component = item['component'] as Record<string, unknown> | undefined;
            const variable = item['variable'] as Record<string, unknown> | undefined;
            const componentName = component?.['name'] as string | undefined;
            const variableName = variable?.['name'] as string | undefined;
            const instance = variable?.['instance'] as string | undefined;
            keys.push(variableKey(componentName ?? '', variableName ?? '', instance));
            const known = VARIABLES.find(
              (v) =>
                v.component === componentName &&
                v.variable === variableName &&
                v.instance === instance,
            );
            return known != null
              ? { attributeStatus: 'Accepted', attributeValue: known.value, component, variable }
              : { attributeStatus: 'UnknownVariable', component, variable };
          });
          receivedRequests.push(keys);
          return { getVariableResult };
        }
        return { status: 'NotSupported' };
      },
    );

    // Step 1: manually request CSMS for the 5 variables.
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetVariables', {
        stationId: ctx.stationId,
        getVariableData: VARIABLES.map((v) => ({
          component: { name: v.component },
          variable: { name: v.variable, ...(v.instance != null ? { instance: v.instance } : {}) },
        })),
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const sizes = receivedRequests.map((r) => r.length);
    const sortedSizes = [...sizes].sort((a, b) => a - b);
    const requestedKeys = receivedRequests.flat().sort();
    const splitAsExpected =
      sortedSizes.length === 2 &&
      sortedSizes[0] === 1 &&
      sortedSizes[1] === MAX_ITEMS &&
      requestedKeys.length === EXPECTED_KEYS.length &&
      requestedKeys.every((k, i) => k === EXPECTED_KEYS[i]);

    steps.push({
      step: 1,
      description: `GetVariablesRequest for ${String(MAX_ITEMS)} variables and one for 1 variable`,
      status: splitAsExpected ? 'passed' : 'failed',
      expected: `Two requests (${String(MAX_ITEMS)} + 1 items) covering ${EXPECTED_KEYS.join(', ')}`,
      actual:
        receivedRequests.length === 0
          ? 'No GetVariablesRequest received'
          : receivedRequests.map((r) => `[${r.join(', ')}]`).join(' '),
    });

    // Post scenario: no GetVariablesRequest exceeds ItemsPerMessageGetVariables.
    const allWithinLimit = sizes.length > 0 && sizes.every((count) => count <= MAX_ITEMS);

    steps.push({
      step: 2,
      description: `Each request contains at most ${String(MAX_ITEMS)} variables`,
      status: allWithinLimit ? 'passed' : 'failed',
      expected: `Each request has <= ${String(MAX_ITEMS)} items`,
      actual: `Request sizes: ${sizes.map(String).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
