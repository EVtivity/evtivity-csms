// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_P_03_CS: CsTestCase = {
  id: 'TC_P_03_CS',
  name: 'CustomData - Receive custom data',
  module: 'P-data-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Checks if the CS is able to receive custom data in SetVariables/GetVariables.',
  purpose: 'To verify whether the CS is able to handle receiving custom data.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: SetVariables with OfflineThreshold
    const setRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          attributeType: 'Actual',
          attributeValue: '200',
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
        },
      ],
    });
    const setResults = setRes['setVariableResult'] as Array<Record<string, unknown>> | undefined;
    const setStatus = setResults?.[0]?.['attributeStatus'] as string;
    steps.push({
      step: 1,
      description: 'SetVariablesResponse attributeStatus Accepted',
      status: setStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${setStatus}`,
    });

    // Step 2: GetVariables to verify
    const getRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          attributeType: 'Actual',
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
        },
      ],
    });
    const getResults = getRes['getVariableResult'] as Array<Record<string, unknown>> | undefined;
    const getStatus = getResults?.[0]?.['attributeStatus'] as string;
    const getValue = getResults?.[0]?.['attributeValue'] as string;
    steps.push({
      step: 2,
      description: 'GetVariablesResponse Accepted with value 200',
      status: getStatus === 'Accepted' && getValue === '200' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted, attributeValue = 200',
      actual: `attributeStatus = ${getStatus}, attributeValue = ${getValue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_P_04_CS: CsTestCase = {
  id: 'TC_P_04_CS',
  name: 'Able to receive customData - ChargingProfile',
  module: 'P-data-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Checks if the CS is able to receive custom data in smart charging profiles.',
  purpose: 'To verify whether the CS handles custom data in charging profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const setRes = await ctx.server.sendCommand('SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 100,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        customData: { vendorId: 'org.openchargealliance.test' },
        chargingSchedule: [
          {
            id: 1,
            duration: 3600,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              {
                startPeriod: 0,
                limit: 6000,
                numberPhases: 3,
                customData: { vendorId: 'org.openchargealliance.test' },
              },
            ],
          },
        ],
      },
    });
    const status = setRes['status'] as string;
    steps.push({
      step: 1,
      description: 'SetChargingProfileResponse Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
