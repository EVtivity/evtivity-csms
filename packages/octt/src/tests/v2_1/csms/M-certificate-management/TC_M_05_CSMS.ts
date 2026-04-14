// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeInstallCertTest = (
  id: string,
  name: string,
  certType: string,
  respondStatus: string,
): TestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: `The CSMS requests the Charging Station to install a ${certType} certificate.`,
  purpose: `To verify the CSMS can install a ${certType} certificate.`,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'InstallCertificate') {
        received = true;
        return { status: respondStatus };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'InstallCertificate', {
        stationId: ctx.stationId,
        certificateType: certType,
        certificate:
          '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJALRiMLAh0APWMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBm15\ndGVzdDAeFw0yMzAxMDEwMDAwMDBaFw0yNDAxMDEwMDAwMDBaMBExDzANBgNVBAMM\nBm15dGVzdDBcMA0GCSqGSIb3DQEBAQUABEsASUVTVA==\n-----END CERTIFICATE-----',
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: `CSMS sends InstallCertificateRequest for ${certType}`,
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: `Respond with status ${respondStatus}`,
      status: received ? 'passed' : 'failed',
      expected: `Response ${respondStatus}`,
      actual: received ? respondStatus : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_M_01_CSMS = makeInstallCertTest(
  'TC_M_01_CSMS',
  'Install CA certificate - CSMSRootCertificate',
  'CSMSRootCertificate',
  'Accepted',
);
export const TC_M_02_CSMS = makeInstallCertTest(
  'TC_M_02_CSMS',
  'Install CA certificate - ManufacturerRootCertificate',
  'ManufacturerRootCertificate',
  'Accepted',
);
export const TC_M_03_CSMS = makeInstallCertTest(
  'TC_M_03_CSMS',
  'Install CA certificate - V2GRootCertificate',
  'V2GRootCertificate',
  'Accepted',
);
export const TC_M_04_CSMS = makeInstallCertTest(
  'TC_M_04_CSMS',
  'Install CA certificate - MORootCertificate',
  'MORootCertificate',
  'Accepted',
);
export const TC_M_05_CSMS = makeInstallCertTest(
  'TC_M_05_CSMS',
  'Install CA certificate - Failed',
  'CSMSRootCertificate',
  'Failed',
);
export const TC_M_101_CSMS = makeInstallCertTest(
  'TC_M_101_CSMS',
  'Install CA certificate - OEMRootCertificate',
  'OEMRootCertificate',
  'Accepted',
);
