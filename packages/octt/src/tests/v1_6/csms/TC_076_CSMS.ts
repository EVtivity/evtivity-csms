// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_076_CSMS: TestCase = {
  id: 'TC_076_CSMS',
  name: 'Delete a Specific Certificate from the Charge Point (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Delete an installed certificate from the Charge Point.',
  purpose:
    'Verify the CSMS can send InstallCertificate, GetInstalledCertificateIds, and DeleteCertificate with multiple hash algorithms.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const hashAlgorithms = ['SHA256', 'SHA384', 'SHA512'];
    let stepNum = 0;

    for (const hashAlgorithm of hashAlgorithms) {
      let installReceived = false;
      let getIdsReceived = false;
      let deleteReceived = false;
      let deleteHashAlgorithm = '';

      ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
        if (action === 'InstallCertificate') {
          installReceived = true;
          return { status: 'Accepted' };
        }
        if (action === 'GetInstalledCertificateIds') {
          getIdsReceived = true;
          return {
            status: 'Accepted',
            certificateHashData: [
              {
                hashAlgorithm,
                issuerNameHash: `issuer-name-${hashAlgorithm.toLowerCase()}`,
                issuerKeyHash: `issuer-key-${hashAlgorithm.toLowerCase()}`,
                serialNumber: `serial-${hashAlgorithm.toLowerCase()}`,
              },
            ],
          };
        }
        if (action === 'DeleteCertificate') {
          deleteReceived = true;
          const hashData = payload['certificateHashData'] as Record<string, unknown> | undefined;
          deleteHashAlgorithm = (hashData?.['hashAlgorithm'] as string) || '';
          return { status: 'Accepted' };
        }
        return {};
      });

      if (ctx.triggerCommand != null) {
        await ctx.triggerCommand('v16', 'InstallCertificate', {
          stationId: ctx.stationId,
          certificateType: 'CentralSystemRootCertificate',
          certificate: '-----BEGIN CERTIFICATE-----\nMIIBxx...\n-----END CERTIFICATE-----',
        });
        await ctx.triggerCommand('v16', 'GetInstalledCertificateIds', {
          stationId: ctx.stationId,
          certificateType: 'CentralSystemRootCertificate',
        });
        await ctx.triggerCommand('v16', 'DeleteCertificate', {
          stationId: ctx.stationId,
          certificateHashData: {
            hashAlgorithm,
            issuerNameHash: `issuer-name-${hashAlgorithm.toLowerCase()}`,
            issuerKeyHash: `issuer-key-${hashAlgorithm.toLowerCase()}`,
            serialNumber: `serial-${hashAlgorithm.toLowerCase()}`,
          },
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      stepNum++;
      steps.push({
        step: stepNum,
        description: `[${hashAlgorithm}] InstallCertificate received and responded Accepted`,
        status: installReceived ? 'passed' : 'failed',
        expected: 'InstallCertificate.req received',
        actual: installReceived ? 'Received' : 'Not received',
      });

      stepNum++;
      steps.push({
        step: stepNum,
        description: `[${hashAlgorithm}] GetInstalledCertificateIds received and responded with hash data`,
        status: getIdsReceived ? 'passed' : 'failed',
        expected: 'GetInstalledCertificateIds.req received',
        actual: getIdsReceived ? 'Received' : 'Not received',
      });

      stepNum++;
      steps.push({
        step: stepNum,
        description: `[${hashAlgorithm}] DeleteCertificate received with ${hashAlgorithm} hash and responded Accepted`,
        status: deleteReceived && deleteHashAlgorithm === hashAlgorithm ? 'passed' : 'failed',
        expected: `DeleteCertificate.req with hashAlgorithm=${hashAlgorithm}`,
        actual: deleteReceived ? `Received, hashAlgorithm=${deleteHashAlgorithm}` : 'Not received',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
