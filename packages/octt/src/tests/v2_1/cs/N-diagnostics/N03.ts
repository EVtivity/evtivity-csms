// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_05_CS: CsTestCase = {
  id: 'TC_N_05_CS',
  name: 'Set Monitoring Base - success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends SetMonitoringBaseRequest for All, FactoryDefault and HardWiredOnly.',
  purpose: 'To test that Charging Station supports all three monitoring base types.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    for (const [i, base] of (['All', 'FactoryDefault', 'HardWiredOnly'] as const).entries()) {
      const res = await ctx.server.sendCommand('SetMonitoringBase', { monitoringBase: base });
      steps.push({
        step: i + 1,
        description: `SetMonitoringBaseResponse for ${base}`,
        status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${res['status']}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_06_CS: CsTestCase = {
  id: 'TC_N_06_CS',
  name: 'Set Monitoring Base - test removal custom monitors',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends SetMonitoringBaseRequest for HardWiredOnly to remove custom monitors.',
  purpose: 'To test that Charging Station removes custom monitors when selecting HardWiredOnly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const cv = [
      { component: { name: 'ChargingStation' }, variable: { name: 'AvailabilityState' } },
    ];

    const getRes1 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 20,
      componentVariable: cv,
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse Accepted (monitor exists)',
      status: (getRes1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${getRes1['status']}`,
    });

    try {
      await ctx.server.waitForMessage('NotifyMonitoringReport', 15000);
    } catch {
      /* consume report */
    }

    const setRes = await ctx.server.sendCommand('SetMonitoringBase', {
      monitoringBase: 'HardWiredOnly',
    });
    steps.push({
      step: 2,
      description: 'SetMonitoringBaseResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });

    const getRes2 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 21,
      componentVariable: cv,
    });
    steps.push({
      step: 3,
      description: 'GetMonitoringReportResponse EmptyResultSet (monitor removed)',
      status: (getRes2['status'] as string) === 'EmptyResultSet' ? 'passed' : 'failed',
      expected: 'status = EmptyResultSet',
      actual: `status = ${getRes2['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_07_CS: CsTestCase = {
  id: 'TC_N_07_CS',
  name: 'Set Monitoring Base - for unknown base type',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends SetMonitoringBase with an invalid monitoringBase value.',
  purpose: 'To test that Charging Station returns NotSupported for invalid monitoringBase.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('SetMonitoringBase', {
      monitoringBase: 'UnsupportedBase',
    });
    steps.push({
      step: 1,
      description: 'SetMonitoringBaseResponse NotSupported',
      status: (res['status'] as string) === 'NotSupported' ? 'passed' : 'failed',
      expected: 'status = NotSupported',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_41_CS: CsTestCase = {
  id: 'TC_N_41_CS',
  name: 'Set Variable Monitoring - Return to FactoryDefault',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS overrides a preconfigured monitor and then restores to FactoryDefault.',
  purpose: 'To verify if the Charging Station correctly restores monitors to FactoryDefault.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const getRes = await ctx.server.sendCommand('GetMonitoringReport', { requestId: 22 });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse Accepted',
      status: (getRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${getRes['status']}`,
    });

    try {
      await ctx.server.waitForMessage('NotifyMonitoringReport', 15000);
    } catch {
      /* consume */
    }

    const setBase = await ctx.server.sendCommand('SetMonitoringBase', {
      monitoringBase: 'FactoryDefault',
    });
    steps.push({
      step: 2,
      description: 'SetMonitoringBase FactoryDefault Accepted',
      status: (setBase['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setBase['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
