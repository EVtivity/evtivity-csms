// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_019_CS: CsTestCase = {
  id: 'TC_019_CS',
  name: 'Retrieve configuration',
  module: '08-configuration-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System is able to retrieve all available or specific configuration keys.',
  purpose: 'To check whether the Charge Point has all required keys configured.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Step 1: Get SupportedFeatureProfiles
    const r1 = await ctx.server.sendCommand('GetConfiguration', {
      key: ['SupportedFeatureProfiles'],
    });
    const keys1 = r1['configurationKey'] as Array<Record<string, unknown>> | undefined;
    steps.push({
      step: 2,
      description: 'GetConfiguration for SupportedFeatureProfiles',
      status: keys1 !== undefined && keys1.length > 0 ? 'passed' : 'failed',
      expected: 'configurationKey includes SupportedFeatureProfiles',
      actual: keys1 !== undefined ? `${String(keys1.length)} keys` : 'No keys',
    });

    // Step 3: Get all configuration keys (empty key list)
    const r2 = await ctx.server.sendCommand('GetConfiguration', { key: [] });
    const keys2 = r2['configurationKey'] as Array<Record<string, unknown>> | undefined;
    steps.push({
      step: 4,
      description: 'GetConfiguration for all keys',
      status: keys2 !== undefined && keys2.length > 0 ? 'passed' : 'failed',
      expected: 'All configuration keys returned',
      actual: keys2 !== undefined ? `${String(keys2.length)} keys` : 'No keys',
    });

    // Step 5: Get GetConfigurationMaxKeys
    const r3 = await ctx.server.sendCommand('GetConfiguration', {
      key: ['GetConfigurationMaxKeys'],
    });
    steps.push({
      step: 6,
      description: 'GetConfiguration for GetConfigurationMaxKeys',
      status: r3 !== undefined ? 'passed' : 'failed',
      expected: 'Response received',
      actual: r3 !== undefined ? 'Received' : 'Not received',
    });

    // Step 7: Get a subset of keys
    const r4 = await ctx.server.sendCommand('GetConfiguration', {
      key: ['HeartbeatInterval', 'NumberOfConnectors'],
    });
    const keys4 = r4['configurationKey'] as Array<Record<string, unknown>> | undefined;
    steps.push({
      step: 8,
      description: 'GetConfiguration for specific keys',
      status: keys4 !== undefined && keys4.length > 0 ? 'passed' : 'failed',
      expected: 'Requested keys returned',
      actual: keys4 !== undefined ? `${String(keys4.length)} keys` : 'No keys',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_021_CS: CsTestCase = {
  id: 'TC_021_CS',
  name: 'Change/set Configuration',
  module: '08-configuration-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to set the value of a configuration key.',
  purpose:
    'To test if the Charge Point sets the configuration key value, specified by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const changeResp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'MeterValueSampleInterval',
      value: '30',
    });
    steps.push({
      step: 2,
      description: 'ChangeConfiguration Accepted',
      status: (changeResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(changeResp['status'])}`,
    });

    const getResp = await ctx.server.sendCommand('GetConfiguration', {
      key: ['MeterValueSampleInterval'],
    });
    const keys = getResp['configurationKey'] as Array<Record<string, unknown>> | undefined;
    const val = keys?.[0]?.['value'] as string | undefined;
    steps.push({
      step: 4,
      description: 'GetConfiguration confirms new value',
      status: val === '30' ? 'passed' : 'failed',
      expected: 'value = 30',
      actual: `value = ${String(val)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
