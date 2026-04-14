// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_16_CS: CsTestCase = {
  id: 'TC_B_16_CS',
  name: 'Get Custom Report - with component criteria',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a custom report based on a set of component criteria.',
  purpose: 'To test that Charging Station supports a custom report query.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentCriteria: ['Enabled'],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    try {
      const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
      const reqIdReported = notifyPayload['requestId'] as number;
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received with correct requestId',
        status: reqIdReported === requestId ? 'passed' : 'failed',
        expected: `requestId = ${String(requestId)}`,
        actual: `requestId = ${String(reqIdReported)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out waiting for NotifyReport',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_17_CS: CsTestCase = {
  id: 'TC_B_17_CS',
  name: 'Get Custom Report - with component/variable',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a custom report for AvailabilityState of EVSE #1.',
  purpose: 'To test that Charging Station supports a custom report query.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentVariable: [
        {
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    try {
      const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
      const reportData = notifyPayload['reportData'] as Array<Record<string, unknown>>;
      const firstEntry = reportData?.[0];
      const compName = (firstEntry?.['component'] as Record<string, unknown>)?.['name'] as string;
      const varName = (firstEntry?.['variable'] as Record<string, unknown>)?.['name'] as string;

      steps.push({
        step: 3,
        description: 'NotifyReport: reportData[0].component.name = EVSE',
        status: compName === 'EVSE' ? 'passed' : 'failed',
        expected: 'component.name = EVSE',
        actual: `component.name = ${compName}`,
      });

      steps.push({
        step: 3,
        description: 'NotifyReport: reportData[0].variable.name = AvailabilityState',
        status: varName === 'AvailabilityState' ? 'passed' : 'failed',
        expected: 'variable.name = AvailabilityState',
        actual: `variable.name = ${varName}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out waiting for NotifyReport',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_18_CS: CsTestCase = {
  id: 'TC_B_18_CS',
  name: 'Get Custom Report - with component criteria and component/variable',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS requests a custom report for AvailabilityState of EVSE #1 as Available and with Problem.',
  purpose:
    'To test that Charging Station supports a custom report query and that it takes the component criteria into account.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // First request: Available criteria
    const requestId1 = Math.floor(Math.random() * 1000000);
    const res1 = await ctx.server.sendCommand('GetReport', {
      requestId: requestId1,
      componentCriteria: ['Available'],
      componentVariable: [
        {
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const status1 = res1['status'] as string;

    steps.push({
      step: 2,
      description: 'First GetReportResponse (Available criteria): status = Accepted',
      status: status1 === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status1}`,
    });

    try {
      await ctx.server.waitForMessage('NotifyReport', 10000);
      steps.push({
        step: 3,
        description: 'NotifyReport received for Available criteria',
        status: 'passed',
        expected: 'NotifyReportRequest received',
        actual: 'NotifyReportRequest received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReport received for Available criteria',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out',
      });
    }

    // Second request: Problem criteria (should return EmptyResultSet)
    const requestId2 = Math.floor(Math.random() * 1000000);
    const res2 = await ctx.server.sendCommand('GetReport', {
      requestId: requestId2,
      componentCriteria: ['Problem'],
      componentVariable: [
        {
          component: { name: 'EVSE', evse: { id: 1 } },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const status2 = res2['status'] as string;

    steps.push({
      step: 6,
      description: 'Second GetReportResponse (Problem criteria): status = EmptyResultSet',
      status: status2 === 'EmptyResultSet' ? 'passed' : 'failed',
      expected: 'status = EmptyResultSet',
      actual: `status = ${status2}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_19_CS: CsTestCase = {
  id: 'TC_B_19_CS',
  name: 'Get Custom Report - for unknown component criteria',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS sends a GetReport with an invalid value in componentCriteria.',
  purpose:
    'To test that Charging Station returns NotSupported for an invalid componentCriteria value.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentCriteria: ['Available', 'UnsupportedCriteria'],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = NotSupported',
      status: status === 'NotSupported' ? 'passed' : 'failed',
      expected: 'status = NotSupported',
      actual: `status = ${status}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_54_CS: CsTestCase = {
  id: 'TC_B_54_CS',
  name: 'Get Custom Report - with component/variable, but no instance',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests a custom report for ItemsPerMessage of DeviceDataCtrlr.',
  purpose: 'To test that Charging Station will send all instances if instance is not given.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentVariable: [
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'ItemsPerMessage' },
        },
      ],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    try {
      const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
      const reportData = notifyPayload['reportData'] as Array<Record<string, unknown>>;
      const hasMultipleInstances = reportData != null && reportData.length >= 2;

      steps.push({
        step: 3,
        description: 'NotifyReport contains multiple instances of ItemsPerMessage',
        status: hasMultipleInstances ? 'passed' : 'failed',
        expected: 'Multiple reportData entries for different instances',
        actual: `reportData entries: ${String(reportData?.length ?? 0)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out waiting for NotifyReport',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_55_CS: CsTestCase = {
  id: 'TC_B_55_CS',
  name: 'Get Custom Report - with component/variable/instance',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS requests a custom report for ItemsPerMessage of DeviceDataCtrlr with a specific instance.',
  purpose: 'To test that Charging Station will send one instance if instance is given.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentVariable: [
        {
          component: { name: 'DeviceDataCtrlr' },
          variable: { name: 'ItemsPerMessage', instance: 'GetReport' },
        },
      ],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    try {
      const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
      const reportData = notifyPayload['reportData'] as Array<Record<string, unknown>>;
      const firstEntry = reportData?.[0];
      const varInstance = (firstEntry?.['variable'] as Record<string, unknown>)?.[
        'instance'
      ] as string;

      steps.push({
        step: 3,
        description: 'NotifyReport: variable.instance = GetReport',
        status: varInstance === 'GetReport' ? 'passed' : 'failed',
        expected: 'variable.instance = GetReport',
        actual: `variable.instance = ${varInstance}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out waiting for NotifyReport',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_56_CS: CsTestCase = {
  id: 'TC_B_56_CS',
  name: 'Get Custom Report - with component/variable, but no evseId',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS requests a custom report for AvailabilityState of EVSE without specifying evseId.',
  purpose: 'To test that Charging Station will send all EVSEs when evseId is not given.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const requestId = Math.floor(Math.random() * 1000000);
    const res = await ctx.server.sendCommand('GetReport', {
      requestId,
      componentVariable: [
        {
          component: { name: 'EVSE' },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });
    const status = res['status'] as string;

    steps.push({
      step: 2,
      description: 'GetReportResponse: status = Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    try {
      const notifyPayload = await ctx.server.waitForMessage('NotifyReport', 15000);
      const reportData = notifyPayload['reportData'] as Array<Record<string, unknown>>;
      const allEvse = reportData?.every(
        (rd) => (rd['component'] as Record<string, unknown>)?.['name'] === 'EVSE',
      );

      steps.push({
        step: 3,
        description: 'NotifyReport contains EVSE entries for all EVSEs',
        status: allEvse && reportData != null && reportData.length >= 1 ? 'passed' : 'failed',
        expected: 'reportData entries for all EVSEs',
        actual: `reportData entries: ${String(reportData?.length ?? 0)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyReportRequest received',
        status: 'failed',
        expected: 'NotifyReportRequest received',
        actual: 'Timed out waiting for NotifyReport',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
