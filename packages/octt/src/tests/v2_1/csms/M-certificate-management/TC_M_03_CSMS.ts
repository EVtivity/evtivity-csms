// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeCertRetrieveTest = (id: string, name: string, certType: string): TestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: `The CSMS retrieves ${certType} certificates from the Charging Station.`,
  purpose: `To verify the CSMS can retrieve ${certType} certificate hash data.`,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let requestedType: string | undefined;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetInstalledCertificateIds') {
          received = true;
          const types = payload['certificateType'] as string[] | undefined;
          if (Array.isArray(types) && types.length > 0) requestedType = types[0];
          return {
            status: 'Accepted',
            certificateHashDataChain: [
              {
                certificateType: certType,
                certificateHashData: {
                  hashAlgorithm: 'SHA256',
                  issuerNameHash: 'aabbcc',
                  issuerKeyHash: 'ddeeff',
                  serialNumber: '01',
                },
              },
            ],
          };
        }
        if (action === 'InstallCertificate') return { status: 'Accepted' };
        if (action === 'DeleteCertificate') return { status: 'Accepted' };
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: [certType],
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: `CSMS sends GetInstalledCertificateIdsRequest for ${certType}`,
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? `Received (type: ${requestedType ?? 'omitted'})` : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_M_12_CSMS = makeCertRetrieveTest(
  'TC_M_12_CSMS',
  'Retrieve certificates - CSMSRootCertificate',
  'CSMSRootCertificate',
);
export const TC_M_13_CSMS = makeCertRetrieveTest(
  'TC_M_13_CSMS',
  'Retrieve certificates - ManufacturerRootCertificate',
  'ManufacturerRootCertificate',
);
export const TC_M_14_CSMS = makeCertRetrieveTest(
  'TC_M_14_CSMS',
  'Retrieve certificates - V2GRootCertificate',
  'V2GRootCertificate',
);
export const TC_M_15_CSMS = makeCertRetrieveTest(
  'TC_M_15_CSMS',
  'Retrieve certificates - V2GCertificateChain',
  'V2GCertificateChain',
);
export const TC_M_16_CSMS = makeCertRetrieveTest(
  'TC_M_16_CSMS',
  'Retrieve certificates - MORootCertificate',
  'MORootCertificate',
);
const makeMultiCertRetrieveTest = (id: string, name: string, certTypes: string[]): TestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: `The CSMS retrieves ${certTypes.join(', ')} certificates from the Charging Station.`,
  purpose: `To verify the CSMS can retrieve multiple certificate types in a single request.`,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let requestedTypes: string[] = [];
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetInstalledCertificateIds') {
          received = true;
          const types = payload['certificateType'] as string[] | undefined;
          if (Array.isArray(types)) requestedTypes = types;
          return {
            status: 'Accepted',
            certificateHashDataChain: certTypes.map((ct) => ({
              certificateType: ct,
              certificateHashData: {
                hashAlgorithm: 'SHA256',
                issuerNameHash: 'aabbcc',
                issuerKeyHash: 'ddeeff',
                serialNumber: '01',
              },
            })),
          };
        }
        if (action === 'InstallCertificate') return { status: 'Accepted' };
        if (action === 'DeleteCertificate') return { status: 'Accepted' };
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: certTypes,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: `CSMS sends GetInstalledCertificateIdsRequest for ${certTypes.join(', ')}`,
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received
        ? `Received (types: ${requestedTypes.join(', ') || 'omitted'})`
        : 'Not received',
    });
    const allTypesPresent = certTypes.every((ct) => requestedTypes.includes(ct));
    steps.push({
      step: 2,
      description: `Request contains all expected certificate types`,
      status: received && allTypesPresent ? 'passed' : 'failed',
      expected: `certificateType includes ${certTypes.join(', ')}`,
      actual: received
        ? allTypesPresent
          ? 'All types present'
          : `Missing types: ${certTypes.filter((ct) => !requestedTypes.includes(ct)).join(', ')}`
        : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_M_17_CSMS = makeMultiCertRetrieveTest(
  'TC_M_17_CSMS',
  'Retrieve certificates - CSMSRoot & ManufacturerRoot',
  ['CSMSRootCertificate', 'ManufacturerRootCertificate'],
);
export const TC_M_18_CSMS = makeMultiCertRetrieveTest(
  'TC_M_18_CSMS',
  'Retrieve certificates - All certificateTypes',
  [
    'CSMSRootCertificate',
    'ManufacturerRootCertificate',
    'V2GRootCertificate',
    'MORootCertificate',
    'V2GCertificateChain',
  ],
);

export const TC_M_19_CSMS: TestCase = {
  id: 'TC_M_19_CSMS',
  name: 'Retrieve certificates - No matching certificate found',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a response indicating no matching certificates found.',
  purpose: 'To verify the CSMS handles NotFound response for GetInstalledCertificateIds.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetInstalledCertificateIds') {
        received = true;
        return { status: 'NotFound' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: ['CSMSRootCertificate'],
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetInstalledCertificateIdsRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'Respond with status NotFound',
      status: received ? 'passed' : 'failed',
      expected: 'Response sent',
      actual: received ? 'Sent' : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
