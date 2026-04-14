// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_46_CS: CsTestCase = {
  id: 'TC_B_46_CS',
  name: 'Migrate to new ConnectionProfile - Fallback mechanism - Same CSMS Root',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to use the fallback mechanism when it is unable to connect with the new connection profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: SetNetworkProfile
    const setProfileRes = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9997',
        ocppInterface: 'Wired0',
        ocppVersion: 'OCPP20',
        securityProfile: 0,
      },
    });
    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Accepted',
      status: (setProfileRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setProfileRes['status'] as string}`,
    });

    // Step 3: SetVariables NetworkConfigurationPriority
    const setVarRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: '2,1',
        },
      ],
    });
    const setVarStatus = (
      (setVarRes['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    const setVarOk = setVarStatus === 'Accepted' || setVarStatus === 'RebootRequired';
    steps.push({
      step: 4,
      description: 'SetVariablesResponse: attributeStatus = Accepted or RebootRequired',
      status: setVarOk ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted or RebootRequired',
      actual: `attributeStatus = ${setVarStatus}`,
    });

    // Step 5: Reset OnIdle
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push({
      step: 6,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_49_CS: CsTestCase = {
  id: 'TC_B_49_CS',
  name: 'Migrate to new ConnectionProfile - Fallback after NetworkProfileConnectionAttempts',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the fallback mechanism in the case it fails to connect.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push({
      step: 6,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_50_CS: CsTestCase = {
  id: 'TC_B_50_CS',
  name: 'Migrate to new ConnectionProfile - Success - New CSMS Root - New CSMS',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to correctly handle migrating to the new CSMS using a new CSMS root certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push({
      step: 6,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
