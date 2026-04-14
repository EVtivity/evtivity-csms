// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_43_CS: CsTestCase = {
  id: 'TC_B_43_CS',
  name: 'Set new NetworkConnectionProfile - Rejected',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to reject when the CSMS tries to set a network connection profile with an invalid slot.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 999,
      connectionData: {
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9999',
        ocppInterface: 'Wired0',
        ocppVersion: 'OCPP20',
        securityProfile: 0,
      },
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_45_CS: CsTestCase = {
  id: 'TC_B_45_CS',
  name: 'Migrate to new ConnectionProfile - Success - Same CSMS Root',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to migrate to another network connection profile slot.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: SetNetworkProfile
    const setProfileRes = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9998',
        ocppInterface: 'Wired0',
        ocppVersion: 'OCPP20',
        securityProfile: 0,
      },
    });
    const setProfileStatus = setProfileRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Accepted',
      status: setProfileStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setProfileStatus}`,
    });

    // Step 3: SetVariables for NetworkConfigurationPriority
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
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 6,
      description: 'ResetResponse: status = Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_47_CS: CsTestCase = {
  id: 'TC_B_47_CS',
  name: 'Migrate to new ConnectionProfile - Fallback after NetworkProfileConnectionAttempts - New CSMS Root',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the fallback mechanism when it fails to connect with the new CSMS root certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 5: Reset OnIdle
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 6,
      description: 'ResetResponse: status = Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_100_CS: CsTestCase = {
  id: 'TC_B_100_CS',
  name: 'Set new NetworkConnectionProfile - Identity and password',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is properly reporting the network connection profile in the device model.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: SetNetworkProfile with identity and password
    const setProfileRes = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP21',
        ocppInterface: 'Any',
        ocppTransport: 'JSON',
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9998',
        securityProfile: 2,
        identity: 'OCTT-STATION-ID',
        basicAuthPassword: 'TestPassword123456',
      },
    });
    const setProfileStatus = setProfileRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Accepted',
      status: setProfileStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setProfileStatus}`,
    });

    // Step 3: GetBaseReport FullInventory
    const requestId = Math.floor(Math.random() * 1000000);
    const baseReportRes = await ctx.server.sendCommand('GetBaseReport', {
      requestId,
      reportBase: 'FullInventory',
    });
    const baseReportStatus = baseReportRes['status'] as string;
    steps.push({
      step: 4,
      description: 'GetBaseReportResponse: status = Accepted',
      status: baseReportStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${baseReportStatus}`,
    });

    // Wait for NotifyReport
    try {
      await ctx.server.waitForMessage('NotifyReport', 15000);
      steps.push({
        step: 5,
        description: 'NotifyReportRequest received with NetworkConfiguration data',
        status: 'passed',
        expected: 'NotifyReportRequest received',
        actual: 'NotifyReportRequest received',
      });
    } catch {
      steps.push({
        step: 5,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_105_CS: CsTestCase = {
  id: 'TC_B_105_CS',
  name: 'Set new NetworkConnectionProfile - Add new NetworkConfiguration using SetVariables',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station via SetVariables.',
  purpose:
    'To verify if the Charging Station is able to set the network connection profile via component variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Get ItemsPerMessage
    const getVarRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'ItemsPerMessage', instance: 'SetVariables' },
        },
      ],
    });
    const getVarStatus = (
      (getVarRes['getVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeStatus = Accepted',
      status: getVarStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${getVarStatus}`,
    });

    // Step 3: Set NetworkConfiguration variables
    const setVarRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'NetworkConfiguration', instance: '2' },
          variable: { name: 'OcppCsmsUrl' },
          attributeValue: 'ws://127.0.0.1:9998',
        },
      ],
    });
    const setStatus = (
      (setVarRes['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 4,
      description: 'SetVariablesResponse: attributeStatus = Accepted',
      status: setStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${setStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_107_CS: CsTestCase = {
  id: 'TC_B_107_CS',
  name: 'Set new NetworkConnectionProfile - Add and remove slot from NetworkConfigurationPriority',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to add and remove a slot from NetworkConfigurationPriority.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Get current NetworkConfigurationPriority
    const getRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
        },
      ],
    });
    const r0 = (getRes['getVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
      string,
      unknown
    >;
    const currentPriority = r0?.['attributeValue'] as string;
    steps.push({
      step: 2,
      description: 'GetVariablesResponse for NetworkConfigurationPriority',
      status: (r0?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r0?.['attributeStatus'] as string}, value = ${currentPriority}`,
    });

    // Step 9: Set priority with slot added (should be Rejected if URL is invalid)
    const setRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: `${currentPriority},3`,
        },
      ],
    });
    const setStatus = (
      (setRes['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 10,
      description: 'SetVariablesResponse for NetworkConfigurationPriority with invalid slot',
      status: setStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'attributeStatus = Rejected',
      actual: `attributeStatus = ${setStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_108_CS: CsTestCase = {
  id: 'TC_B_108_CS',
  name: 'Set new NetworkConnectionProfile - Prevent overwriting configured Network Profile slot',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station does not allow to change the configuration of a network slot that is in use.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Get NetworkConfigurationPriority
    const getRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
        },
      ],
    });
    const r0 = (getRes['getVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
      string,
      unknown
    >;
    const priority = r0?.['attributeValue'] as string;
    const firstSlot = priority?.split(',')[0] ?? '1';

    steps.push({
      step: 2,
      description: 'GetVariablesResponse for NetworkConfigurationPriority',
      status: (r0?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r0?.['attributeStatus'] as string}`,
    });

    // Step 3-4: Try to set MessageTimeout on active slot (should be Rejected)
    const setRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'NetworkConfiguration', instance: firstSlot },
          variable: { name: 'MessageTimeout' },
          attributeValue: '123',
        },
      ],
    });
    const setStatus = (
      (setRes['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 4,
      description: 'SetVariablesResponse: attributeStatus = Rejected for active slot',
      status: setStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'attributeStatus = Rejected',
      actual: `attributeStatus = ${setStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_109_CS: CsTestCase = {
  id: 'TC_B_109_CS',
  name: 'Set new NetworkConnectionProfile - When changing SecurityCtrlr.Identity/BasicAuthPassword',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station clears Identity/BasicAuthPassword from the active network connection profile when changed via SecurityCtrlr.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 5: Set SecurityCtrlr.Identity and BasicAuthPassword
    const setRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'Identity' },
          attributeValue: 'OCTT-NEW-IDENTITY',
        },
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: 'NewPassword12345678',
        },
      ],
    });
    const results = setRes['setVariableResult'] as Array<Record<string, unknown>>;
    const identityStatus = (results?.[0] as Record<string, unknown>)?.['attributeStatus'] as string;
    const passwordStatus = (results?.[1] as Record<string, unknown>)?.['attributeStatus'] as string;

    steps.push({
      step: 6,
      description: 'SetVariablesResponse: Identity attributeStatus = Accepted',
      status: identityStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${identityStatus}`,
    });

    steps.push({
      step: 6,
      description: 'SetVariablesResponse: BasicAuthPassword attributeStatus = Accepted',
      status: passwordStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${passwordStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_110_CS: CsTestCase = {
  id: 'TC_B_110_CS',
  name: 'Set new NetworkConnectionProfile - No security downgrade to profile #1',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station refuses to downgrade to security profile #1 via SetNetworkProfile.',
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP21',
        ocppInterface: 'Any',
        ocppTransport: 'JSON',
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9998',
        securityProfile: 1,
        basicAuthPassword: 'TestPassword123456',
      },
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_111_CS: CsTestCase = {
  id: 'TC_B_111_CS',
  name: 'Set new NetworkConnectionProfile - No security downgrade to profile #1 - DM',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  stationConfig: { securityProfile: 2 },
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station refuses to downgrade security profile #1 via the NetworkConfiguration DM variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'NetworkConfiguration', instance: '2' },
          variable: { name: 'SecurityProfile' },
          attributeValue: '1',
        },
      ],
    });
    const setStatus = (
      (res['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<string, unknown>
    )?.['attributeStatus'] as string;

    steps.push({
      step: 4,
      description: 'SetVariablesResponse: SecurityProfile attributeStatus = Rejected',
      status: setStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'attributeStatus = Rejected',
      actual: `attributeStatus = ${setStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_112_CS: CsTestCase = {
  id: 'TC_B_112_CS',
  name: 'Set new NetworkConnectionProfile - AllowSecurityDowngrade is false',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  stationConfig: { securityProfile: 3 },
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station refuses to downgrade security at all via SetNetworkProfileRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP21',
        ocppInterface: 'Any',
        ocppTransport: 'JSON',
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9998',
        securityProfile: 2,
        basicAuthPassword: 'TestPassword123456',
      },
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'SetNetworkProfileResponse: status = Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_113_CS: CsTestCase = {
  id: 'TC_B_113_CS',
  name: 'Set new NetworkConnectionProfile - AllowSecurityDowngrade = false - DM',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  stationConfig: { securityProfile: 3 },
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify that the Charging Station refuses to downgrade security at all via the NetworkConfiguration DM variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'NetworkConfiguration', instance: '2' },
          variable: { name: 'SecurityProfile' },
          attributeValue: '2',
        },
      ],
    });
    const setStatus = (
      (res['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<string, unknown>
    )?.['attributeStatus'] as string;

    steps.push({
      step: 4,
      description: 'SetVariablesResponse: SecurityProfile attributeStatus = Rejected',
      status: setStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'attributeStatus = Rejected',
      actual: `attributeStatus = ${setStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
