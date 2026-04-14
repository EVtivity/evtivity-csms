// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_09_CS: CsTestCase = {
  id: 'TC_B_09_CS',
  name: 'Set Variables - single value',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Set the value of one of the required variables of OCPPCommCtrlr.',
  purpose:
    'To test setting a single value using SetVariablesRequest for one of the required variables.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot first

    // Step 1-2: CSMS sends SetVariables
    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
          attributeType: 'Actual',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const attrType = r?.['attributeType'] as string;
    const compName = (r?.['component'] as Record<string, unknown>)?.['name'] as string;
    const varName = (r?.['variable'] as Record<string, unknown>)?.['name'] as string;

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeStatus = Accepted',
      status: attrStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = Accepted',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeType = Actual',
      status: attrType === 'Actual' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeType = Actual',
      actual: `setVariableResult[0].attributeType = ${attrType}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: component.name = OCPPCommCtrlr',
      status: compName === 'OCPPCommCtrlr' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].component.name = OCPPCommCtrlr',
      actual: `setVariableResult[0].component.name = ${compName}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: variable.name = OfflineThreshold',
      status: varName === 'OfflineThreshold' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].variable.name = OfflineThreshold',
      actual: `setVariableResult[0].variable.name = ${varName}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_10_CS: CsTestCase = {
  id: 'TC_B_10_CS',
  name: 'Set Variables - multiple values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Set the value of two required variables.',
  purpose: 'To test setting multiple values using SetVariablesRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
          attributeType: 'Actual',
        },
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalAuthorizeOffline' },
          attributeValue: 'true',
          attributeType: 'Actual',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;

    // Check first result (OCPPCommCtrlr / OfflineThreshold)
    const r0 = results?.[0] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'SetVariableResult[0]: attributeStatus = Accepted',
      status: (r0?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r0?.['attributeStatus'] as string}`,
    });

    // Check second result (AuthCtrlr / LocalAuthorizeOffline)
    const r1 = results?.[1] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'SetVariableResult[1]: attributeStatus = Accepted',
      status: (r1?.['attributeStatus'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted',
      actual: `attributeStatus = ${r1?.['attributeStatus'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_35_CS: CsTestCase = {
  id: 'TC_B_35_CS',
  name: 'Set Variables - Unknown component',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a SetVariablesRequest for an unknown component.',
  purpose:
    'To verify whether the Charging Station can handle receiving a SetVariablesRequest for an unknown component.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'UnknownComponent' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeStatus = UnknownComponent',
      status: attrStatus === 'UnknownComponent' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = UnknownComponent',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_36_CS: CsTestCase = {
  id: 'TC_B_36_CS',
  name: 'Set Variables - Unknown variable',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a SetVariablesRequest for an unknown variable.',
  purpose:
    'To verify whether the Charging Station can handle receiving a SetVariablesRequest for an unknown variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'UnknownVariable' },
          attributeValue: '300',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeStatus = UnknownVariable',
      status: attrStatus === 'UnknownVariable' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = UnknownVariable',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_37_CS: CsTestCase = {
  id: 'TC_B_37_CS',
  name: 'Set Variables - Not supported attribute type',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a SetVariablesRequest with a not supported attribute type.',
  purpose:
    'To verify whether the Charging Station can handle receiving a SetVariablesRequest for a not supported attribute type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
          attributeType: 'Target',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const attrType = r?.['attributeType'] as string;

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeStatus = NotSupportedAttributeType',
      status: attrStatus === 'NotSupportedAttributeType' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = NotSupportedAttributeType',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeType = Target',
      status: attrType === 'Target' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeType = Target',
      actual: `setVariableResult[0].attributeType = ${attrType}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_11_CS: CsTestCase = {
  id: 'TC_B_11_CS',
  name: 'Set Variables - invalidly formatted values',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Set the value of variables with invalidly formatted values.',
  purpose: 'To test setting of variables of different type with invalidly formatted values.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Test with an invalid value for OfflineThreshold (expects integer, send a non-integer)
    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: 'abc',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const validStatuses = ['Rejected', 'Accepted'];

    steps.push({
      step: 2,
      description:
        'SetVariablesResponse: attributeStatus = Rejected or Accepted for invalid value "abc"',
      status: validStatuses.includes(attrStatus) ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = Rejected or Accepted',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_39_CS: CsTestCase = {
  id: 'TC_B_39_CS',
  name: 'Set Variables - Read-only',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a SetVariablesRequest for a Read-only variable.',
  purpose:
    'To verify whether the Charging Station can handle receiving a SetVariablesRequest for a Read-only variable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const res = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'MessageTimeout', instance: 'Default' },
          attributeValue: '30',
        },
      ],
    });
    const results = res['setVariableResult'] as Array<Record<string, unknown>>;
    const r = results?.[0] as Record<string, unknown> | undefined;
    const attrStatus = r?.['attributeStatus'] as string;
    const compName = (r?.['component'] as Record<string, unknown>)?.['name'] as string;
    const varName = (r?.['variable'] as Record<string, unknown>)?.['name'] as string;

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: attributeStatus = Rejected',
      status: attrStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = Rejected',
      actual: `setVariableResult[0].attributeStatus = ${attrStatus}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: component.name = OCPPCommCtrlr',
      status: compName === 'OCPPCommCtrlr' ? 'passed' : 'failed',
      expected: 'component.name = OCPPCommCtrlr',
      actual: `component.name = ${compName}`,
    });

    steps.push({
      step: 2,
      description: 'SetVariablesResponse: variable.name = MessageTimeout',
      status: varName === 'MessageTimeout' ? 'passed' : 'failed',
      expected: 'variable.name = MessageTimeout',
      actual: `variable.name = ${varName}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
