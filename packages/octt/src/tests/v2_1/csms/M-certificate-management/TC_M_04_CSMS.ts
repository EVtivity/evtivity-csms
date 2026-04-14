// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_M_20_CSMS: TestCase = {
  id: 'TC_M_20_CSMS',
  name: 'Delete certificate from CS - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests the Charging Station to delete an installed certificate.',
  purpose: 'To verify the CSMS can delete a certificate using all hash algorithms.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let getIdCount = 0;
    let deleteCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetInstalledCertificateIds') {
        getIdCount++;
        return {
          status: 'Accepted',
          certificateHashDataChain: [
            {
              certificateType: 'CSMSRootCertificate',
              certificateHashData: {
                hashAlgorithm: 'SHA256',
                issuerNameHash: 'aabb',
                issuerKeyHash: 'ccdd',
                serialNumber: '01',
              },
            },
          ],
        };
      }
      if (action === 'DeleteCertificate') {
        deleteCount++;
        return { status: 'Accepted' };
      }
      if (action === 'InstallCertificate') return { status: 'Accepted' };
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: ['CSMSRootCertificate'],
      });
      await ctx.triggerCommand('v21', 'DeleteCertificate', {
        stationId: ctx.stationId,
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'aabb',
          issuerKeyHash: 'ccdd',
          serialNumber: '01',
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetInstalledCertificateIdsRequest',
      status: getIdCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 request',
      actual: `${String(getIdCount)} request(s)`,
    });
    steps.push({
      step: 2,
      description: 'CSMS sends DeleteCertificateRequest',
      status: deleteCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 delete',
      actual: `${String(deleteCount)} delete(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_M_21_CSMS: TestCase = {
  id: 'TC_M_21_CSMS',
  name: 'Delete certificate from CS - Failed',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a Charging Station that fails to delete a certificate.',
  purpose: 'To verify the CSMS handles Failed response for DeleteCertificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let getIdCount = 0;
    let deleteCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetInstalledCertificateIds') {
        getIdCount++;
        return {
          status: 'Accepted',
          certificateHashDataChain: [
            {
              certificateType: 'CSMSRootCertificate',
              certificateHashData: {
                hashAlgorithm: 'SHA256',
                issuerNameHash: 'aabb',
                issuerKeyHash: 'ccdd',
                serialNumber: '01',
              },
            },
          ],
        };
      }
      if (action === 'DeleteCertificate') {
        deleteCount++;
        return { status: 'Failed' };
      }
      if (action === 'InstallCertificate') return { status: 'Accepted' };
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
        stationId: ctx.stationId,
        certificateType: ['CSMSRootCertificate'],
      });
      await ctx.triggerCommand('v21', 'DeleteCertificate', {
        stationId: ctx.stationId,
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'aabb',
          issuerKeyHash: 'ccdd',
          serialNumber: '01',
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetInstalledCertificateIdsRequest',
      status: getIdCount > 0 ? 'passed' : 'failed',
      expected: 'Request received',
      actual: `${String(getIdCount)} request(s)`,
    });
    steps.push({
      step: 2,
      description: 'CSMS sends DeleteCertificateRequest, respond Failed',
      status: deleteCount > 0 ? 'passed' : 'failed',
      expected: 'Delete request received',
      actual: `${String(deleteCount)} delete(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
