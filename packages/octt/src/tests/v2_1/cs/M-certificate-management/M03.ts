// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const createGetInstalledCertTest = (
  id: string,
  name: string,
  certType: string,
  description: string,
  purpose: string,
): CsTestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description,
  purpose,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });
    const res = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: [certType],
    });
    const status = res['status'] as string;
    steps.push({
      step: 1,
      description: `GetInstalledCertificateIds for ${certType}`,
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
});

export const TC_M_12_CS = createGetInstalledCertTest(
  'TC_M_12_CS',
  'Retrieve certificates - CSMSRootCertificate',
  'CSMSRootCertificate',
  'The CSMS retrieves certificates from the Charging Station.',
  'To verify if the Charging Station provides hashData from all stored CSMSRootCertificates.',
);
export const TC_M_13_CS = createGetInstalledCertTest(
  'TC_M_13_CS',
  'Retrieve certificates - ManufacturerRootCertificate',
  'ManufacturerRootCertificate',
  'The CSMS retrieves certificates from the Charging Station.',
  'To verify if the Charging Station provides hashData from all stored ManufacturerRootCertificates.',
);
export const TC_M_14_CS = createGetInstalledCertTest(
  'TC_M_14_CS',
  'Retrieve certificates - V2GRootCertificate',
  'V2GRootCertificate',
  'The CSMS retrieves certificates from the Charging Station.',
  'To verify if the Charging Station provides hashData from all stored V2GRootCertificates.',
);

export const TC_M_15_CS: CsTestCase = {
  id: 'TC_M_15_CS',
  name: 'Retrieve certificates - V2GCertificateChain',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS retrieves V2G certificate chain from the Charging Station.',
  purpose:
    'To verify if the Charging Station provides hashData from all stored V2GCertificateChain certificates.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });
    const res = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['V2GCertificateChain'],
    });
    const status = res['status'] as string;
    const chains = res['certificateHashDataChain'] as Array<Record<string, unknown>> | undefined;
    const hasV2GChain = chains?.some(
      (c) =>
        c['certificateType'] === 'V2GCertificateChain' && c['childCertificateHashData'] != null,
    );
    steps.push({
      step: 1,
      description:
        'GetInstalledCertificateIds for V2GCertificateChain, verify childCertificateHashData',
      status: status === 'Accepted' && hasV2GChain ? 'passed' : 'failed',
      expected:
        'status = Accepted, certificateType = V2GCertificateChain with childCertificateHashData',
      actual: `status = ${status}, hasV2GChain = ${hasV2GChain}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_16_CS = createGetInstalledCertTest(
  'TC_M_16_CS',
  'Retrieve certificates - MORootCertificate',
  'MORootCertificate',
  'The CSMS retrieves certificates from the Charging Station.',
  'To verify if the Charging Station provides hashData from all stored MORootCertificates.',
);

export const TC_M_17_CS: CsTestCase = {
  id: 'TC_M_17_CS',
  name: 'Retrieve certificates - CSMSRootCertificate & ManufacturerRootCertificate',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS retrieves both CSMSRootCertificate and ManufacturerRootCertificate.',
  purpose: 'To verify if the Charging Station provides hashData from both certificate types.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });
    const res = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['CSMSRootCertificate', 'ManufacturerRootCertificate'],
    });
    const status = res['status'] as string;
    steps.push({
      step: 1,
      description: 'GetInstalledCertificateIds for CSMSRoot and ManufacturerRoot',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_18_CS: CsTestCase = {
  id: 'TC_M_18_CS',
  name: 'Retrieve certificates - All certificateTypes',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS retrieves all certificate types (certificateType omitted).',
  purpose: 'To verify if the Charging Station provides hashData from all stored certificates.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });
    const res = await ctx.server.sendCommand('GetInstalledCertificateIds', {});
    const status = res['status'] as string;
    const chains = res['certificateHashDataChain'] as Array<Record<string, unknown>> | undefined;
    const types = chains?.map((c) => c['certificateType'] as string) ?? [];
    const hasCsms = types.includes('CSMSRootCertificate');
    const hasMfg = types.includes('ManufacturerRootCertificate');
    steps.push({
      step: 1,
      description:
        'GetInstalledCertificateIdsResponse with Accepted, contains CSMS and Manufacturer entries',
      status: status === 'Accepted' && hasCsms && hasMfg ? 'passed' : 'failed',
      expected: 'status = Accepted, contains CSMSRootCertificate and ManufacturerRootCertificate',
      actual: `status = ${status}, types = ${types.join(', ')}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_19_CS: CsTestCase = {
  id: 'TC_M_19_CS',
  name: 'Retrieve certificates - No matching certificate found',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests certificates of a type not installed on the Charging Station.',
  purpose:
    'To verify if the Charging Station responds that it did not find any certificate of the requested type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });
    const res = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['OEMRootCertificate'],
    });
    const status = res['status'] as string;
    const chains = res['certificateHashDataChain'];
    steps.push({
      step: 1,
      description:
        'GetInstalledCertificateIdsResponse with NotFound, certificateHashDataChain omitted',
      status: status === 'NotFound' && chains == null ? 'passed' : 'failed',
      expected: 'status = NotFound, certificateHashDataChain = omitted',
      actual: `status = ${status}, chains = ${String(chains)}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
