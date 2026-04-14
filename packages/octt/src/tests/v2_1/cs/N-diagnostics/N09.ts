// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_27_CS: CsTestCase = {
  id: 'TC_N_27_CS',
  name: 'Get Customer Information - Accepted + data',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS retrieves customer information from the Charging Station.',
  purpose: 'To verify if the Charging Station accepts the request and sends the information.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 1,
      report: true,
      clear: false,
      idToken: { idToken: 'TEST_TOKEN', type: 'ISO14443' },
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('NotifyCustomerInformation', 30000);
      const data = msg['data'] as string;
      steps.push({
        step: 2,
        description: 'NotifyCustomerInformation with data not empty',
        status: data != null && data !== '' ? 'passed' : 'failed',
        expected: 'data not empty',
        actual: `data = ${data?.substring(0, 50)}...`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'NotifyCustomerInformation',
        status: 'failed',
        expected: 'data not empty',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_28_CS: CsTestCase = {
  id: 'TC_N_28_CS',
  name: 'Get Customer Information - Accepted + no data',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS retrieves customer information but no data is found.',
  purpose: 'To verify if the Charging Station responds correctly when no matching data is found.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 2,
      report: true,
      clear: false,
      idToken: { idToken: 'UNKNOWN_TOKEN', type: 'ISO14443' },
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('NotifyCustomerInformation', 30000);
      const tbc = msg['tbc'] as boolean | undefined;
      steps.push({
        step: 2,
        description: 'NotifyCustomerInformation tbc not true',
        status: tbc !== true ? 'passed' : 'failed',
        expected: 'tbc != true',
        actual: `tbc = ${tbc}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'NotifyCustomerInformation',
        status: 'failed',
        expected: 'tbc != true',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_29_CS: CsTestCase = {
  id: 'TC_N_29_CS',
  name: 'Get Customer Information - Not Accepted',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a customer information request that the station cannot process.',
  purpose: 'To verify if the Charging Station correctly responds with Invalid status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 3,
      report: true,
      clear: false,
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Invalid',
      status: (res['status'] as string) === 'Invalid' ? 'passed' : 'failed',
      expected: 'status = Invalid',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
