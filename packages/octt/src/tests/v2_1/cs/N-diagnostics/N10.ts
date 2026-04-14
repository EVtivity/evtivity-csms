// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_30_CS: CsTestCase = {
  id: 'TC_N_30_CS',
  name: 'Clear Customer Information - Clear and report + data',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears and retrieves customer information.',
  purpose: 'To verify if the Charging Station clears customer data and reports it before clearing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 4,
      report: true,
      clear: true,
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
      steps.push({
        step: 2,
        description: 'NotifyCustomerInformation data not empty',
        status: (msg['data'] as string)?.length > 0 ? 'passed' : 'failed',
        expected: 'data not empty',
        actual: `data length = ${(msg['data'] as string)?.length}`,
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

export const TC_N_31_CS: CsTestCase = {
  id: 'TC_N_31_CS',
  name: 'Clear Customer Information - Clear and report + no data',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears customer information when none exists.',
  purpose: 'To verify if the Charging Station responds correctly when no matching data is found.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 5,
      report: true,
      clear: true,
      idToken: { idToken: 'UNKNOWN_TOKEN', type: 'ISO14443' },
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_32_CS: CsTestCase = {
  id: 'TC_N_32_CS',
  name: 'Clear Customer Information - Clear and no report',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears customer information without requesting a report.',
  purpose: 'To verify if the Charging Station clears data without sending a report.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 6,
      report: false,
      clear: true,
      idToken: { idToken: 'TEST_TOKEN', type: 'ISO14443' },
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_62_CS: CsTestCase = {
  id: 'TC_N_62_CS',
  name: 'Clear Customer Information - customerIdentifier',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears customer information by customerIdentifier.',
  purpose:
    'To verify if the Charging Station clears data by customerIdentifier and confirms empty on re-query.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res1 = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 7,
      report: true,
      clear: true,
      customerIdentifier: 'CUST-001',
    });
    steps.push({
      step: 1,
      description: 'First CustomerInformationResponse Accepted',
      status: (res1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res1['status']}`,
    });
    try {
      const msg = await ctx.server.waitForMessage('NotifyCustomerInformation', 30000);
      steps.push({
        step: 2,
        description: 'First NotifyCustomerInformation data not empty',
        status: (msg['data'] as string)?.length > 0 ? 'passed' : 'failed',
        expected: 'data not empty',
        actual: `data length = ${(msg['data'] as string)?.length}`,
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

    const res2 = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 8,
      report: true,
      clear: false,
      customerIdentifier: 'CUST-001',
    });
    steps.push({
      step: 3,
      description: 'Second CustomerInformationResponse Accepted',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });
    try {
      const msg = await ctx.server.waitForMessage('NotifyCustomerInformation', 30000);
      steps.push({
        step: 4,
        description: 'Second NotifyCustomerInformation data empty',
        status: (msg['data'] as string)?.length === 0 || msg['data'] == null ? 'passed' : 'failed',
        expected: 'data empty',
        actual: `data = ${msg['data']}`,
      });
    } catch {
      steps.push({
        step: 4,
        description: 'NotifyCustomerInformation empty',
        status: 'failed',
        expected: 'data empty',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_63_CS: CsTestCase = {
  id: 'TC_N_63_CS',
  name: 'Clear Customer Information - customerCertificate',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears customer information by customerCertificate.',
  purpose: 'To verify if the Charging Station clears customer certificate data.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const certHash = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'AAAA',
      issuerKeyHash: 'BBBB',
      serialNumber: '111111',
    };
    const res1 = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 9,
      report: true,
      clear: true,
      customerCertificate: certHash,
    });
    steps.push({
      step: 1,
      description: 'CustomerInformationResponse Accepted',
      status: (res1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res1['status']}`,
    });

    const res2 = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 10,
      report: true,
      clear: false,
      customerCertificate: certHash,
    });
    steps.push({
      step: 2,
      description: 'Second CustomerInformationResponse Accepted',
      status: (res2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res2['status']}`,
    });
    try {
      const msg = await ctx.server.waitForMessage('NotifyCustomerInformation', 30000);
      steps.push({
        step: 3,
        description: 'Second NotifyCustomerInformation data empty',
        status: (msg['data'] as string)?.length === 0 || msg['data'] == null ? 'passed' : 'failed',
        expected: 'data empty',
        actual: `data = ${msg['data']}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyCustomerInformation',
        status: 'failed',
        expected: 'data empty',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_33_CS: CsTestCase = {
  id: 'TC_N_33_CS',
  name: 'Clear Customer Information - Invalid',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends an invalid clear customer information request.',
  purpose: 'To verify if the Charging Station rejects the request.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('CustomerInformation', {
      requestId: 11,
      report: true,
      clear: true,
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
