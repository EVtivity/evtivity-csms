// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { checkIso2Response, updateRequest } from '../../../../iso15118-test-ev.js';
import {
  pushResponseSteps,
  setUpContracts,
  skippedContractTest,
} from '../../../../iso15118-contract-helpers.js';

export const TC_M_28_CSMS: TestCase = {
  id: 'TC_M_28_CSMS',
  name: 'Certificate Update EV - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV initiates updating the existing certificate. The Charging Station forwards the update request to the CSMS.',
  purpose:
    'To verify if the CSMS is able to return the Raw CertificateInstallationRes response for the EV to the Charging Station.',
  execute: async (ctx) => {
    const setup = await setUpContracts(ctx, 2, 1);
    if (typeof setup === 'string') return skippedContractTest(setup);
    const steps: StepResult[] = [];
    try {
      await ctx.client.sendCall('BootNotification', {
        chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
        reason: 'PowerUp',
      });
      // Precondition: the EV holds a contract certificate to update.
      const install = await ctx.client.sendCall('Get15118EVCertificate', {
        iso15118SchemaVersion: setup.ev.namespace,
        action: 'Install',
        exiRequest: setup.ev.installationRequest(),
      });
      const installed =
        typeof install['exiResponse'] === 'string' && install['exiResponse'] !== ''
          ? checkIso2Response(install['exiResponse'], 'CertificateInstallationRes', setup.ev.oemKey)
          : { ok: false as const, reason: `Install answered ${String(install['status'])}` };
      if (!installed.ok) {
        steps.push({
          step: 0,
          description: 'Precondition: the EV installs a contract certificate',
          status: 'failed',
          actual: installed.reason,
        });
        return { status: 'failed', durationMs: 0, steps };
      }

      // Step 1: Get15118EVCertificateRequest with action Update, signed with the contract key.
      const resp = await ctx.client.sendCall('Get15118EVCertificate', {
        iso15118SchemaVersion: setup.ev.namespace,
        action: 'Update',
        exiRequest: updateRequest(installed.contract),
      });
      // Step 2: status Accepted and the raw response for the EV.
      pushResponseSteps(steps, 2, resp);
      const check =
        typeof resp['exiResponse'] === 'string' && resp['exiResponse'] !== ''
          ? checkIso2Response(
              resp['exiResponse'],
              'CertificateUpdateRes',
              installed.contract.privateKey,
            )
          : { ok: false as const, reason: 'No exiResponse' };
      const renewed =
        check.ok && !check.contract.certificate.equals(installed.contract.certificate);
      steps.push({
        step: 2,
        description: 'The EV accepts the CertificateUpdateRes with a new contract certificate',
        status:
          renewed && check.ok && check.contract.emaid === installed.contract.emaid
            ? 'passed'
            : 'failed',
        expected: `ResponseCode OK, valid CPS signature, key encrypted to the current contract, eMAID ${installed.contract.emaid}`,
        actual: check.ok
          ? `eMAID ${check.contract.emaid}, new certificate ${String(renewed)}`
          : check.reason,
      });
    } finally {
      await setup.cleanup();
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
