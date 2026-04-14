// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_040_1_CS: CsTestCase = {
  id: 'TC_040_1_CS',
  name: 'Configuration key - NotSupported',
  module: '16-configuration-keys-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to reject an unknown configuration key.',
  purpose: 'To test if the Charge Point reports NotSupported for an unknown key.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const resp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'Testing',
      value: 'true',
    });
    steps.push({
      step: 2,
      description: 'ChangeConfiguration NotSupported',
      status: (resp['status'] as string) === 'NotSupported' ? 'passed' : 'failed',
      expected: 'status = NotSupported',
      actual: `status = ${String(resp['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_040_2_CS: CsTestCase = {
  id: 'TC_040_2_CS',
  name: 'Configuration key - Invalid value',
  module: '16-configuration-keys-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to reject setting a configuration key with an incorrect value.',
  purpose: 'To test if the Charge Point rejects an incorrect configuration value.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const resp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'MeterValueSampleInterval',
      value: '-1',
    });
    const status = resp['status'] as string | undefined;
    const ok = status === 'Rejected';
    steps.push({
      step: 2,
      description: 'ChangeConfiguration Rejected for invalid value',
      status: ok ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
