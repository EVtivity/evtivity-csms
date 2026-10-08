// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { checkIso2Response, checkIso20Response } from '@evtivity/css/iso15118-test-ev';
import {
  pushResponseSteps,
  setUpContracts,
  skippedContractTest,
} from '../../../../iso15118-contract-helpers.js';

function status(steps: StepResult[]): 'passed' | 'failed' {
  return steps.every((s) => s.status === 'passed') ? 'passed' : 'failed';
}

export const TC_M_26_CSMS: TestCase = {
  id: 'TC_M_26_CSMS',
  name: 'Certificate Installation EV - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV initiates installing a new certificate. The Charging Station forwards the request for a new certificate to the CSMS.',
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
      // Step 1: Get15118EVCertificateRequest with action Install (ISO 15118-2).
      const resp = await ctx.client.sendCall('Get15118EVCertificate', {
        iso15118SchemaVersion: setup.ev.namespace,
        action: 'Install',
        exiRequest: setup.ev.installationRequest(),
      });
      // Step 2: status Accepted and the raw CertificateInstallationRes.
      pushResponseSteps(steps, 2, resp);
      const check =
        typeof resp['exiResponse'] === 'string' && resp['exiResponse'] !== ''
          ? checkIso2Response(resp['exiResponse'], 'CertificateInstallationRes', setup.ev.oemKey)
          : { ok: false as const, reason: 'No exiResponse' };
      steps.push({
        step: 2,
        description: 'The EV accepts the CertificateInstallationRes (signature, key, contract)',
        status: check.ok && check.contract.emaid === setup.emaids[0] ? 'passed' : 'failed',
        expected: `ResponseCode OK, valid CPS signature, decryptable key, eMAID ${String(setup.emaids[0])}`,
        actual: check.ok ? `eMAID ${check.contract.emaid}` : check.reason,
      });
    } finally {
      await setup.cleanup();
    }
    return { status: status(steps), durationMs: 0, steps };
  },
};

export const TC_M_100_CSMS: TestCase = {
  id: 'TC_M_100_CSMS',
  name: 'Certificate Installation EV - ISO 15118-20 - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV initiates installing a new certificate. The Charging Station forwards the request for a new certificate to the CSMS. 3 ContractCertificateChains will be communicated to the CSMS.',
  purpose:
    'To verify if the CSMS is able to return the Raw CertificateInstallationRes response for the EV to the Charging Station, for every contract of an ISO 15118-20 EV.',
  execute: async (ctx) => {
    const setup = await setUpContracts(ctx, 20, 3);
    if (typeof setup === 'string') return skippedContractTest(setup);
    const steps: StepResult[] = [];
    try {
      await ctx.client.sendCall('BootNotification', {
        chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
        reason: 'PowerUp',
      });
      // The Charging Station sends the same request until remainingContracts is 0.
      const exiRequest = setup.ev.installationRequest({
        maximumContractCertificateChains: 10,
        prioritizedEmaids: setup.emaids,
      });
      const delivered: string[] = [];
      for (let i = 0; i < 3; i++) {
        const resp = await ctx.client.sendCall('Get15118EVCertificate', {
          iso15118SchemaVersion: setup.ev.namespace,
          action: 'Install',
          exiRequest,
          maximumContractCertificateChains: 10,
          prioritizedEMAIDs: setup.emaids,
        });
        pushResponseSteps(steps, i * 2 + 2, resp, 2 - i);
        const check =
          typeof resp['exiResponse'] === 'string' && resp['exiResponse'] !== ''
            ? checkIso20Response(resp['exiResponse'], setup.ev)
            : { ok: false as const, reason: 'No exiResponse' };
        if (check.ok) delivered.push(check.contract.emaid);
        steps.push({
          step: i * 2 + 2,
          description: 'The EV accepts the CertificateInstallationRes (signature, key, remaining)',
          status: check.ok && check.remaining === 2 - i ? 'passed' : 'failed',
          expected: `ResponseCode OK, valid CPS signature, decryptable key, RemainingContractCertificateChains ${String(2 - i)}`,
          actual: check.ok
            ? `eMAID ${check.contract.emaid}, remaining ${String(check.remaining)}`
            : check.reason,
        });
      }
      const allDelivered = setup.emaids.every((emaid) => delivered.includes(emaid));
      steps.push({
        step: 6,
        description: 'Every configured contract was delivered once',
        status: allDelivered && new Set(delivered).size === 3 ? 'passed' : 'failed',
        expected: setup.emaids.join(', '),
        actual: delivered.join(', '),
      });
    } finally {
      await setup.cleanup();
    }
    return { status: status(steps), durationMs: 0, steps };
  },
};
