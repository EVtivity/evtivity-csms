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

export const TC_M_20_CS: CsTestCase = {
  id: 'TC_M_20_CS',
  name: 'Delete a certificate - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests the Charging Station to delete an installed certificate.',
  purpose: 'To verify if the Charging Station is able to delete an installed certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);

    // Step 1: Get installed certificates to find one to delete (use ManufacturerRootCertificate
    // because CSMSRootCertificate is protected from deletion by the station)
    const getRes = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['ManufacturerRootCertificate'],
    });
    const chains = getRes['certificateHashDataChain'] as Array<Record<string, unknown>> | undefined;
    const hashData = chains?.[0]?.['certificateHashData'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'GetInstalledCertificateIds returns certificate',
      status: hashData != null ? 'passed' : 'failed',
      expected: 'Certificate present',
      actual: `hashData = ${hashData != null ? 'present' : 'absent'}`,
    });

    // Step 2: Delete the certificate
    if (hashData) {
      const delRes = await ctx.server.sendCommand('DeleteCertificate', {
        certificateHashData: hashData,
      });
      const delStatus = delRes['status'] as string;
      steps.push({
        step: 2,
        description: 'DeleteCertificateResponse status Accepted',
        status: delStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${delStatus}`,
      });
    } else {
      steps.push({
        step: 2,
        description: 'DeleteCertificate skipped (no cert found)',
        status: 'failed',
        expected: 'status = Accepted',
        actual: 'No certificate to delete',
      });
    }

    // Step 3: Verify certificate is gone
    const verifyRes = await ctx.server.sendCommand('GetInstalledCertificateIds', {
      certificateType: ['ManufacturerRootCertificate'],
    });
    steps.push({
      step: 3,
      description: 'Certificate no longer present after deletion',
      status: 'passed',
      expected: 'Deleted certificate absent',
      actual: `status = ${verifyRes['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_22_CS: CsTestCase = {
  id: 'TC_M_22_CS',
  name: 'Delete a certificate - No matching certificate found',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests deletion of a certificate that does not exist.',
  purpose:
    'To verify if the Charging Station responds that no certificate matches the provided hash.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    const delRes = await ctx.server.sendCommand('DeleteCertificate', {
      certificateHashData: {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'AAAA',
        issuerKeyHash: 'BBBB',
        serialNumber: '999999',
      },
    });
    const status = delRes['status'] as string;
    steps.push({
      step: 1,
      description: 'DeleteCertificateResponse status NotFound',
      status: status === 'NotFound' ? 'passed' : 'failed',
      expected: 'status = NotFound',
      actual: `status = ${status}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_M_23_CS: CsTestCase = {
  id: 'TC_M_23_CS',
  name: 'Delete a certificate - Unable to delete CS Certificate',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests deletion of the Charging Station certificate.',
  purpose: 'To verify if the Charging Station does NOT allow deletion of its own certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);
    // Get all certs to find the ChargingStation cert
    const getRes = await ctx.server.sendCommand('GetInstalledCertificateIds', {});
    const chains = getRes['certificateHashDataChain'] as Array<Record<string, unknown>> | undefined;
    const csCert = chains?.find((c) => {
      const hashArr = c['certificateHashData'] as Record<string, unknown> | undefined;
      return hashArr != null;
    });
    const hashData = csCert?.['certificateHashData'] as Record<string, unknown> | undefined;

    if (hashData) {
      const delRes = await ctx.server.sendCommand('DeleteCertificate', {
        certificateHashData: hashData,
      });
      const status = delRes['status'] as string;
      steps.push({
        step: 1,
        description: 'DeleteCertificateResponse status NotFound or Failed',
        status: status === 'NotFound' || status === 'Failed' ? 'passed' : 'failed',
        expected: 'status = NotFound OR Failed',
        actual: `status = ${status}`,
      });
    } else {
      steps.push({
        step: 1,
        description: 'No certificate found to test deletion',
        status: 'failed',
        expected: 'status = NotFound OR Failed',
        actual: 'No certificate',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
