// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import { defaultReply } from '../../../default-replies.js';
import { testRootCertificate } from '../../../test-certificates.js';

/** A PEM certificate with its line breaks and surrounding whitespace removed. */
function pemBody(pem: unknown): string {
  return typeof pem === 'string' ? pem.replace(/\s+/g, '') : '';
}

/**
 * OCTT 1.6 TC_075 (Install a certificate on the Charge Point): the Central
 * System installs <Configured root certificate> of `certificateType`, then
 * reads the installed certificate ids, which the Test System answers with the
 * hash data of the installed certificate.
 */
export function makeInstallCertificate16Test(
  id: string,
  name: string,
  certificateType: 'ManufacturerRootCertificate' | 'CentralSystemRootCertificate',
): TestCase {
  return {
    id,
    name,
    module: 'security',
    version: 'ocpp1.6',
    sut: 'csms',
    description: `Install a ${certificateType} on the Charge Point.`,
    purpose: `Verify the CSMS can send InstallCertificate (${certificateType}) and GetInstalledCertificateIds.`,
    execute: async (ctx) => {
      const steps: StepResult[] = [];
      const { root, hashData } = await testRootCertificate(`OCTT ${certificateType}`);

      await ctx.client.sendCall('BootNotification', {
        chargePointVendor: 'OCTT',
        chargePointModel: 'OCTT-Virtual-16',
      });

      let install: Record<string, unknown> | null = null;
      let getIds: Record<string, unknown> | null = null;
      ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
        if (action === 'InstallCertificate') {
          install = payload;
          return { status: 'Accepted' };
        }
        if (action === 'GetInstalledCertificateIds') {
          getIds = payload;
          return { status: 'Accepted', certificateHashData: [hashData] };
        }
        return defaultReply('ocpp1.6', action, payload);
      });

      if (ctx.triggerCommand != null) {
        await ctx.triggerCommand('v16', 'InstallCertificate', {
          stationId: ctx.stationId,
          certificateType,
          certificate: root.pem,
        });
        await ctx.triggerCommand('v16', 'GetInstalledCertificateIds', {
          stationId: ctx.stationId,
          certificateType,
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }

      const installed: Record<string, unknown> | null = install;
      const installOk =
        installed != null &&
        installed['certificateType'] === certificateType &&
        pemBody(installed['certificate']) === pemBody(root.pem);
      steps.push({
        step: 1,
        description: `Receive InstallCertificate (${certificateType}) and respond Accepted`,
        status: installOk ? 'passed' : 'failed',
        expected: `certificateType ${certificateType}, certificate is the configured root certificate`,
        actual:
          installed == null
            ? 'Not received'
            : `certificateType ${String(installed['certificateType'])}, certificate ${
                pemBody(installed['certificate']) === pemBody(root.pem) ? 'matches' : 'differs'
              }`,
      });

      const requested: Record<string, unknown> | null = getIds;
      steps.push({
        step: 2,
        description: 'Receive GetInstalledCertificateIds and respond with the installed hash data',
        status:
          requested != null && requested['certificateType'] === certificateType
            ? 'passed'
            : 'failed',
        expected: `GetInstalledCertificateIds.req certificateType ${certificateType}`,
        actual:
          requested == null
            ? 'Not received'
            : `certificateType ${String(requested['certificateType'])}`,
      });

      return {
        status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
        durationMs: 0,
        steps,
      };
    },
  };
}

export const TC_075_1_CSMS = makeInstallCertificate16Test(
  'TC_075_1_CSMS',
  'Install Certificate - ManufacturerRootCertificate (1.6)',
  'ManufacturerRootCertificate',
);
