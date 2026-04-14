// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_075_1_CSMS: TestCase = {
  id: 'TC_075_1_CSMS',
  name: 'Install Certificate - ManufacturerRootCertificate (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Install a Manufacturer root certificate on the Charge Point.',
  purpose: 'Verify the CSMS can send InstallCertificate and GetInstalledCertificateIds.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let installReceived = false;
    let getIdsReceived = false;
    let certType = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'InstallCertificate') {
        installReceived = true;
        certType = (payload['certificateType'] as string) || '';
        return { status: 'Accepted' };
      }
      if (action === 'GetInstalledCertificateIds') {
        getIdsReceived = true;
        return {
          status: 'Accepted',
          certificateHashData: [
            {
              hashAlgorithm: 'SHA256',
              issuerNameHash: 'abc123',
              issuerKeyHash: 'def456',
              serialNumber: '001',
            },
          ],
        };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'InstallCertificate', {
        stationId: ctx.stationId,
        certificateType: 'ManufacturerRootCertificate',
        certificate: '-----BEGIN CERTIFICATE-----\nMIIBxx...\n-----END CERTIFICATE-----',
      });
      await ctx.triggerCommand('v16', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: 'ManufacturerRootCertificate',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    steps.push({
      step: 1,
      description: 'Receive InstallCertificate (ManufacturerRootCertificate) and respond Accepted',
      status: installReceived ? 'passed' : 'failed',
      expected: 'InstallCertificate.req received',
      actual: installReceived ? `Received, certType=${certType}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Receive GetInstalledCertificateIds and respond with hash data',
      status: getIdsReceived ? 'passed' : 'failed',
      expected: 'GetInstalledCertificateIds.req received',
      actual: getIdsReceived ? 'Received, responded with certificateHashData' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
