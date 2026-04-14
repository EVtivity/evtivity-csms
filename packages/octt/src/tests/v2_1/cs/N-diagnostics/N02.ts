// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_01_CS: CsTestCase = {
  id: 'TC_N_01_CS',
  name: 'Get Monitoring Report - with monitoringCriteria',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a report of all monitors matching given monitoringCriteria.',
  purpose: 'To test that Charging Station supports reporting of monitoring via monitoringCriteria.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res1 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 1,
      monitoringCriteria: ['ThresholdMonitoring'],
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse Accepted or EmptyResultSet (ThresholdMonitoring)',
      status: ['Accepted', 'EmptyResultSet'].includes(res1['status'] as string)
        ? 'passed'
        : 'failed',
      expected: 'status = Accepted or EmptyResultSet',
      actual: `status = ${res1['status']}`,
    });

    try {
      await ctx.server.waitForMessage('NotifyMonitoringReport', 15000);
    } catch {
      /* may timeout if no monitors */
    }

    const res2 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 2,
      monitoringCriteria: ['ThresholdMonitoring', 'DeltaMonitoring'],
    });
    steps.push({
      step: 2,
      description: 'GetMonitoringReportResponse Accepted (Threshold+Delta)',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });

    try {
      await ctx.server.waitForMessage('NotifyMonitoringReport', 15000);
    } catch {
      /* may timeout */
    }

    const res3 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 3,
      monitoringCriteria: ['DeltaMonitoring', 'PeriodicMonitoring'],
    });
    steps.push({
      step: 3,
      description: 'GetMonitoringReportResponse Accepted (Delta+Periodic)',
      status: (res3['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res3['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_02_CS: CsTestCase = {
  id: 'TC_N_02_CS',
  name: 'Get Monitoring Report - with component/variable',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a report for specific component/variable pairs.',
  purpose:
    'To test that Charging Station supports reporting for a given list of components and variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 4,
      componentVariable: [
        { component: { name: 'ChargingStation' }, variable: { name: 'AvailabilityState' } },
        { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'AvailabilityState' } },
      ],
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_03_CS: CsTestCase = {
  id: 'TC_N_03_CS',
  name: 'Get Monitoring Report - criteria + component/variable',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a report matching both criteria and component/variable.',
  purpose: 'To test that Charging Station supports combined criteria and component filtering.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const cv = [
      { component: { name: 'ChargingStation' }, variable: { name: 'AvailabilityState' } },
      { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'AvailabilityState' } },
    ];
    const res1 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 5,
      monitoringCriteria: ['ThresholdMonitoring'],
      componentVariable: cv,
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse EmptyResultSet (Threshold on AvailabilityState)',
      status: (res1['status'] as string) === 'EmptyResultSet' ? 'passed' : 'failed',
      expected: 'status = EmptyResultSet',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 6,
      monitoringCriteria: ['DeltaMonitoring'],
      componentVariable: cv,
    });
    steps.push({
      step: 2,
      description: 'GetMonitoringReportResponse Accepted (Delta on AvailabilityState)',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_04_CS: CsTestCase = {
  id: 'TC_N_04_CS',
  name: 'Get Monitoring Report - unknown component criteria',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends a GetMonitoringReport with an invalid monitoringCriteria value.',
  purpose: 'To test that Charging Station returns NotSupported for invalid monitoringCriteria.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 7,
      monitoringCriteria: ['DeltaMonitoring', 'UnsupportedCriteria'],
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse NotSupported',
      status: (res['status'] as string) === 'NotSupported' ? 'passed' : 'failed',
      expected: 'status = NotSupported',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_47_CS: CsTestCase = {
  id: 'TC_N_47_CS',
  name: 'Get Monitoring Report - Report all',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests all monitoring data with both criteria and component omitted.',
  purpose: 'To verify if the Charging Station correctly reports all monitoring data.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetMonitoringReport', { requestId: 8 });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse Accepted or EmptyResultSet',
      status: ['Accepted', 'EmptyResultSet'].includes(res['status'] as string)
        ? 'passed'
        : 'failed',
      expected: 'status = Accepted or EmptyResultSet',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_104_CS: CsTestCase = {
  id: 'TC_N_104_CS',
  name: 'Get Monitoring Report - TargetDeltaMonitoring',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS requests reports for Threshold and Delta criteria including TargetDeltaRelative.',
  purpose: 'To test that Charging Station supports TargetDeltaRelative monitoring criteria.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res1 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 9,
      monitoringCriteria: ['ThresholdMonitoring'],
    });
    steps.push({
      step: 1,
      description: 'GetMonitoringReportResponse for ThresholdMonitoring',
      status: ['Accepted', 'EmptyResultSet'].includes(res1['status'] as string)
        ? 'passed'
        : 'failed',
      expected: 'status = Accepted or EmptyResultSet',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('GetMonitoringReport', {
      requestId: 10,
      monitoringCriteria: ['DeltaMonitoring'],
    });
    steps.push({
      step: 2,
      description: 'GetMonitoringReportResponse Accepted for DeltaMonitoring',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
