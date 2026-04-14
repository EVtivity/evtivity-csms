// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_M_28_CSMS: TestCase = {
  id: 'TC_M_28_CSMS',
  name: 'Certificate Update EV - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV initiates updating an existing certificate via Get15118EVCertificateRequest.',
  purpose: 'To verify the CSMS returns a valid response for certificate update.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('Get15118EVCertificate', {
        iso15118SchemaVersion: '20',
        action: 'Update',
        exiRequest: 'BASE64_ENCODED_EXI_REQUEST',
      });
      const status = resp['status'] as string;
      steps.push({
        step: 1,
        description: 'Send Get15118EVCertificateRequest with action Update',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${status}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send Get15118EVCertificateRequest with action Update',
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
