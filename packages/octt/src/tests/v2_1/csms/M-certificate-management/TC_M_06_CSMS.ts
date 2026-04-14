// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_M_24_CSMS: TestCase = {
  id: 'TC_M_24_CSMS',
  name: 'Get Charging Station Certificate status - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Charging Station requests the CSMS to get the status of a V2G certificate.',
  purpose: 'To verify the CSMS provides the status of a requested V2G certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('GetCertificateStatus', {
        ocspRequestData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'aabb',
          issuerKeyHash: 'ccdd',
          serialNumber: '01',
          responderURL: 'http://ocsp.example.com',
        },
      });
      const status = resp['status'] as string;
      steps.push({
        step: 1,
        description: 'Send GetCertificateStatusRequest',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${status}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send GetCertificateStatusRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
