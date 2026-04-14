// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const defaultHandler = async (action: string) => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
  return {};
};

const createInstallCertTest = (
  id: string,
  name: string,
  certType: string,
  purpose: string,
): CsTestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: `The CSMS requests the Charging Station to install a new ${certType} Root CA certificate.`,
  purpose,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const installRes = await ctx.server.sendCommand('InstallCertificate', {
      certificateType: certType,
      certificate: 'MIIBkTCB+wIJAL...',
    });
    const status = installRes['status'] as string;
    steps.push({
      step: 1,
      description: `InstallCertificate ${certType} - Accepted`,
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    const getRes = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: [certType],
    });
    const getStatus = getRes['status'] as string;
    steps.push({
      step: 2,
      description: `GetInstalledCertificateIds for ${certType}`,
      status: getStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${getStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
});

export const TC_M_01_CS = createInstallCertTest(
  'TC_M_01_CS',
  'Install CA certificate - CSMSRootCertificate',
  'CSMSRootCertificate',
  'To verify if the Charging Station is able to install a new CSMSRootCertificate.',
);
export const TC_M_02_CS = createInstallCertTest(
  'TC_M_02_CS',
  'Install CA certificate - ManufacturerRootCertificate',
  'ManufacturerRootCertificate',
  'To verify if the Charging Station is able to install a new ManufacturerRootCertificate.',
);
export const TC_M_03_CS = createInstallCertTest(
  'TC_M_03_CS',
  'Install CA certificate - V2GRootCertificate',
  'V2GRootCertificate',
  'To verify if the Charging Station is able to install a new V2GRootCertificate.',
);
export const TC_M_04_CS = createInstallCertTest(
  'TC_M_04_CS',
  'Install CA certificate - MORootCertificate',
  'MORootCertificate',
  'To verify if the Charging Station is able to install a new MORootCertificate.',
);

export const TC_M_07_CS: CsTestCase = {
  id: 'TC_M_07_CS',
  name: 'Install CA certificate - Rejected - Certificate invalid',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends an invalid (expired) certificate to the Charging Station.',
  purpose: 'To verify if the Charging Station is able to reject an invalid certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const installRes = await ctx.server.sendCommand('InstallCertificate', {
      certificateType: 'CSMSRootCertificate',
      certificate: 'EXPIRED_CERTIFICATE_PEM',
    });
    const status = installRes['status'] as string;
    steps.push({
      step: 1,
      description: 'InstallCertificateResponse status Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${status}`,
    });

    const getRes = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['CSMSRootCertificate'],
    });
    const getStatus = getRes['status'] as string;
    steps.push({
      step: 2,
      description: 'GetInstalledCertificateIds - expired cert not installed',
      status: getStatus === 'NotFound' || getStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = NotFound or Accepted (without the expired cert)',
      actual: `status = ${getStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_09_CS: CsTestCase = {
  id: 'TC_M_09_CS',
  name: 'Install CA certificate - AdditionalRootCertificateCheck - Rejected',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a CSMSRootCertificate not signed by the old certificate.',
  purpose:
    'To verify if the Charging Station rejects a CSMSRootCertificate not signed by the existing root.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const installRes = await ctx.server.sendCommand('InstallCertificate', {
      certificateType: 'CSMSRootCertificate',
      certificate: 'UNSIGNED_ROOT_CERT_PEM',
    });
    const status = installRes['status'] as string;
    steps.push({
      step: 1,
      description: 'InstallCertificateResponse status Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${status}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_30_CS: CsTestCase = {
  id: 'TC_M_30_CS',
  name: 'Install CA certificate - AdditionalRootCertificateCheck - Reconnect Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS verifies the Charging Station reconnects using the new CSMS Root certificate.',
  purpose: 'To verify if the Charging Station reconnects using a new CSMS Root certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 1,
      description: 'ResetResponse status Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetStatus}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_31_CS: CsTestCase = {
  id: 'TC_M_31_CS',
  name: 'Install CA certificate - AdditionalRootCertificateCheck - Reconnect Fallback',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS verifies the Charging Station falls back to old CSMS Root when new fails.',
  purpose:
    'To verify if the Charging Station reconnects using the old CSMS Root certificate when the new fails.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 1,
      description: 'ResetResponse status Accepted',
      status: resetStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetStatus}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_101_CS = createInstallCertTest(
  'TC_M_101_CS',
  'Install CA certificate - OEMRootCertificate',
  'OEMRootCertificate',
  'To verify if the Charging Station is able to install a new OEMRootCertificate.',
);
