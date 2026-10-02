// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { readRelayedOcspStatus } from '../../../../ocsp-test-service.js';
import { skippedWithoutOcsp } from '../../../../ocsp-test-helpers.js';

export const TC_M_24_CSMS: TestCase = {
  id: 'TC_M_24_CSMS',
  name: 'Get Charging Station Certificate status - Success',
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Charging Station requests the CSMS to get the status of a V2G certificate.',
  purpose: 'To verify the CSMS provides the status of a requested V2G certificate.',
  execute: async (ctx) => {
    const ocsp = ctx.ocsp;
    if (ocsp == null) return skippedWithoutOcsp();
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: one GetCertificateStatusRequest per SubCA of the configured V2G
    // chain, with that SubCA's hashes and the Test System responder URL.
    const subCas = [
      { name: 'CPO Sub-CA 2', cert: ocsp.pki.cpoSubCa2 },
      { name: 'CPO Sub-CA 1', cert: ocsp.pki.cpoSubCa1 },
    ];
    let step = 1;
    for (const subCa of subCas) {
      const resp = await ctx.client.sendCall('GetCertificateStatus', {
        ocspRequestData: ocsp.pki.requestDataFor(subCa.cert),
      });
      const status = resp['status'];
      steps.push({
        step: step++,
        description: `${subCa.name}: GetCertificateStatusResponse status Accepted`,
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${String(status)}`,
      });

      // Step 2: ocspResult is the DER OCSPResponse (RFC 6960), base64 encoded.
      const ocspResult = typeof resp['ocspResult'] === 'string' ? resp['ocspResult'] : '';
      const relayed = readRelayedOcspStatus(ocspResult, subCa.cert);
      steps.push({
        step: step++,
        description: `${subCa.name}: ocspResult is the signed OCSPResponse for the certificate`,
        status: relayed === 'good' ? 'passed' : 'failed',
        expected: 'Base64 DER OCSPResponse, signature valid, certStatus good',
        actual: ocspResult === '' ? 'ocspResult missing' : `certStatus = ${relayed}`,
      });

      const requests = ocsp.responder.requestsFor(subCa.cert.cert.serialNumber);
      steps.push({
        step: step++,
        description: `${subCa.name}: the CSMS sent the OCSP request to the responder URL`,
        status: requests.length > 0 ? 'passed' : 'failed',
        expected: 'OCSP request received by the Test System',
        actual:
          requests.length > 0
            ? `${String(requests.length)} request(s) received`
            : 'No OCSP request received (is the responder host in pnc.ocsp.allowedPrivateHosts?)',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
