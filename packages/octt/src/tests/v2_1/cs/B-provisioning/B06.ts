// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_06_CS: CsTestCase = {
  id: 'TC_B_06_CS',
  name: 'Get Variables - single value',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Get the value of one of the required variables of OCPPCommCtrlr.',
  purpose: 'To test getting a single value using GetVariablesRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Configuration State: OCPPCommCtrlr.OfflineThreshold is 300
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
        },
      ],
    });

    const res = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeType: 'Actual',
        },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const attrType = r?.['attributeType'] as string;
    const attrValue = r?.['attributeValue'] as string;
    const compName = (r?.['component'] as Record<string, unknown>)?.['name'] as string;
    const varName = (r?.['variable'] as Record<string, unknown>)?.['name'] as string;

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeStatus = Accepted',
      status: attrStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${attrStatus}`,
    });

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeType = Actual',
      status: attrType === 'Actual' ? 'passed' : 'failed',
      expected: 'attributeType = Actual',
      actual: `attributeType = ${attrType}`,
    });

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeValue = 300',
      status: attrValue === '300' ? 'passed' : 'failed',
      expected: 'attributeValue = 300',
      actual: `attributeValue = ${attrValue}`,
    });

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: component.name = OCPPCommCtrlr',
      status: compName === 'OCPPCommCtrlr' ? 'passed' : 'failed',
      expected: 'component.name = OCPPCommCtrlr',
      actual: `component.name = ${compName}`,
    });

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: variable.name = OfflineThreshold',
      status: varName === 'OfflineThreshold' ? 'passed' : 'failed',
      expected: 'variable.name = OfflineThreshold',
      actual: `variable.name = ${varName}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_07_CS: CsTestCase = {
  id: 'TC_B_07_CS',
  name: 'Get Variables - multiple values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Get the value of two required variables.',
  purpose: 'To test getting multiple values using GetVariablesRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Configuration State: OCPPCommCtrlr.OfflineThreshold is 300, AuthCtrlr.LocalAuthorizeOffline is true
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
        },
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalAuthorizeOffline' },
          attributeValue: 'true',
        },
      ],
    });

    const res = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeType: 'Actual',
        },
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalAuthorizeOffline' },
          attributeType: 'Actual',
        },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;

    const r0 = results?.[0] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'GetVariableResult[0]: attributeStatus = Accepted',
      status: (r0?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r0?.['attributeStatus'] as string}`,
    });

    const r1 = results?.[1] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'GetVariableResult[1]: attributeStatus = Accepted',
      status: (r1?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r1?.['attributeStatus'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_32_CS: CsTestCase = {
  id: 'TC_B_32_CS',
  name: 'Get Variables - Unknown component',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a GetVariablesRequest for an unknown component.',
  purpose:
    'To verify whether the Charging Station can handle receiving a GetVariablesRequest for an unknown component.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'UnknownComponent' },
          variable: { name: 'OfflineThreshold' },
        },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeStatus = UnknownComponent',
      status: attrStatus === 'UnknownComponent' ? 'passed' : 'failed',
      expected: 'getVariableResult[0].attributeStatus = UnknownComponent',
      actual: `getVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_33_CS: CsTestCase = {
  id: 'TC_B_33_CS',
  name: 'Get Variables - Unknown variable',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a GetVariablesRequest for an unknown variable.',
  purpose:
    'To verify whether the Charging Station can handle receiving a GetVariablesRequest for an unknown variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'UnknownVariable' },
        },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeStatus = UnknownVariable',
      status: attrStatus === 'UnknownVariable' ? 'passed' : 'failed',
      expected: 'getVariableResult[0].attributeStatus = UnknownVariable',
      actual: `getVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_34_CS: CsTestCase = {
  id: 'TC_B_34_CS',
  name: 'Get Variables - Not supported attribute type',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a GetVariablesRequest with a not supported attribute type.',
  purpose:
    'To verify whether the Charging Station can handle receiving a GetVariablesRequest for a not supported attribute type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeType: 'Target',
        },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const attrType = r?.['attributeType'] as string;

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeStatus = NotSupportedAttributeType',
      status: attrStatus === 'NotSupportedAttributeType' ? 'passed' : 'failed',
      expected: 'getVariableResult[0].attributeStatus = NotSupportedAttributeType',
      actual: `getVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    steps.push({
      step: 2,
      description: 'GetVariablesResponse: attributeType = Target',
      status: attrType === 'Target' ? 'passed' : 'failed',
      expected: 'getVariableResult[0].attributeType = Target',
      actual: `getVariableResult[0].attributeType = ${attrType}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
