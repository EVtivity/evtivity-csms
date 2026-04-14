// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_M_26_CSMS: TestCase = {
  id: 'TC_M_26_CSMS',
  name: 'Certificate Installation EV - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV initiates installing a new certificate via Get15118EVCertificateRequest.',
  purpose: 'To verify the CSMS returns a valid Get15118EVCertificateResponse with status Accepted.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('Get15118EVCertificate', {
        iso15118SchemaVersion: '20',
        action: 'Install',
        exiRequest: 'BASE64_ENCODED_EXI_REQUEST',
      });
      const status = resp['status'] as string;
      steps.push({
        step: 1,
        description: 'Send Get15118EVCertificateRequest with action Install',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${status}`,
      });
      const hasExiResponse =
        typeof resp['exiResponse'] === 'string' && (resp['exiResponse'] as string).length > 0;
      steps.push({
        step: 2,
        description: 'Response contains exiResponse',
        status: hasExiResponse ? 'passed' : 'failed',
        expected: 'exiResponse present',
        actual: hasExiResponse ? 'Present' : 'Missing',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send Get15118EVCertificateRequest',
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

export const TC_M_100_CSMS: TestCase = {
  id: 'TC_M_100_CSMS',
  name: 'Certificate Installation EV - ISO 15118-20 - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV initiates installing certificates with ISO 15118-20 multiple chains.',
  purpose: 'To verify the CSMS handles multiple Get15118EVCertificate requests for ISO 15118-20.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    for (let i = 0; i < 3; i++) {
      try {
        const resp = await ctx.client.sendCall('Get15118EVCertificate', {
          iso15118SchemaVersion: '20',
          action: 'Install',
          exiRequest: 'BASE64_ENCODED_EXI_REQUEST',
          maximumContractCertificateChains: 10,
          prioritizedEMAIDs: [`EMAID-${String(i)}`],
        });
        const status = resp['status'] as string;
        steps.push({
          step: i * 2 + 1,
          description: `Send Get15118EVCertificateRequest #${String(i + 1)}`,
          status: status === 'Accepted' ? 'passed' : 'failed',
          expected: 'status = Accepted',
          actual: `status = ${status}`,
        });
      } catch {
        steps.push({
          step: i * 2 + 1,
          description: `Send Get15118EVCertificateRequest #${String(i + 1)}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
