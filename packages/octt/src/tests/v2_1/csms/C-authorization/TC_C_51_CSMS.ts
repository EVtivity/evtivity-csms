// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

export const TC_C_51_CSMS: TestCase = {
  id: 'TC_C_51_CSMS',
  name: 'Authorization using Contract Certificates 15118 - Online - Local validation - Rejected',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the CSMS is able to validate the certificate hash data and the provided eMAID.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    // Step 2: Send AuthorizeRequest with valid idToken but revoked certificate hash data
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-EMAID-REVOKED', type: 'eMAID' },
      iso15118CertificateHashData: [
        {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          issuerKeyHash: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          serialNumber: '99',
          responderURL: 'http://ocsp.example.com',
        },
      ],
    });

    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string | undefined;
    const certStatus = authRes['certificateStatus'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Verify idTokenInfo.status is Invalid for revoked certificate',
      status: authStatus === 'Invalid' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Invalid',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    steps.push({
      step: 3,
      description: 'Verify certificateStatus is CertificateRevoked',
      status: certStatus === 'CertificateRevoked' ? 'passed' : 'failed',
      expected: 'certificateStatus = CertificateRevoked',
      actual: `certificateStatus = ${String(certStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
