// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase, TestContext } from '../../../../types.js';
import { defaultReply } from '../../../../default-replies.js';
import { sameHashData, type HashAlgorithm } from '../../../../cs-security-pki.js';
import { testRootCertificate } from '../../../../test-certificates.js';

/**
 * One round of M04 (Delete a specific certificate from a Charging Station):
 * the station reports an installed CSMSRootCertificate with real hash data of
 * `hashAlgorithm`, the CSMS deletes it, and the DeleteCertificateRequest must
 * carry the hash data the station returned (Validations, Step 4 / Step 3).
 */
async function deleteRound(
  ctx: TestContext,
  steps: StepResult[],
  firstStep: number,
  hashAlgorithm: HashAlgorithm,
  deleteStatus: 'Accepted' | 'Failed',
): Promise<void> {
  const { hashData } = await testRootCertificate('OCTT CSMS Root CA', hashAlgorithm);
  let getIdsType: unknown = null;
  let getIdsReceived = false;
  let deleted: Record<string, unknown> | null = null;
  ctx.client.setIncomingCallHandler(
    async (_mid: string, action: string, payload: Record<string, unknown>) => {
      if (action === 'GetInstalledCertificateIds') {
        getIdsReceived = true;
        getIdsType = payload['certificateType'];
        return {
          status: 'Accepted',
          certificateHashDataChain: [
            { certificateType: 'CSMSRootCertificate', certificateHashData: hashData },
          ],
        };
      }
      if (action === 'DeleteCertificate') {
        deleted = (payload['certificateHashData'] as Record<string, unknown> | undefined) ?? {};
        return { status: deleteStatus };
      }
      if (action === 'InstallCertificate') return { status: 'Accepted' };
      return defaultReply(ctx.version, action, payload);
    },
  );
  if (ctx.triggerCommand != null) {
    await ctx.triggerCommand('v21', 'GetInstalledCertificateIds', {
      stationId: ctx.stationId,
      certificateType: ['CSMSRootCertificate'],
    });
    await ctx.triggerCommand('v21', 'DeleteCertificate', {
      stationId: ctx.stationId,
      certificateHashData: hashData,
    });
  } else {
    await new Promise((r) => setTimeout(r, 8000));
  }
  const types = Array.isArray(getIdsType) ? (getIdsType as unknown[]) : null;
  const typeOk = getIdsType == null || (types?.includes('CSMSRootCertificate') ?? false);
  steps.push({
    step: firstStep,
    description: `${hashAlgorithm}: CSMS sends GetInstalledCertificateIdsRequest`,
    status: getIdsReceived && typeOk ? 'passed' : 'failed',
    expected: 'certificateType contains CSMSRootCertificate or is omitted',
    actual: getIdsReceived ? `certificateType = ${JSON.stringify(getIdsType)}` : 'Not received',
  });
  const deletedData: Record<string, unknown> | null = deleted;
  steps.push({
    step: firstStep + 1,
    description: `${hashAlgorithm}: CSMS sends DeleteCertificateRequest, respond ${deleteStatus}`,
    status: deletedData != null && sameHashData(deletedData, { ...hashData }) ? 'passed' : 'failed',
    expected: `certificateHashData is the returned ${hashAlgorithm} hash data`,
    actual: deletedData == null ? 'Not received' : JSON.stringify(deletedData),
  });
}

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
    // Steps 1 - 5 are repeated for each hash algorithm (SHA256, SHA384, SHA512).
    const algorithms: HashAlgorithm[] = ['SHA256', 'SHA384', 'SHA512'];
    for (const [i, algorithm] of algorithms.entries()) {
      await deleteRound(ctx, steps, i * 2 + 1, algorithm, 'Accepted');
    }
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
    await deleteRound(ctx, steps, 1, 'SHA256', 'Failed');
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
