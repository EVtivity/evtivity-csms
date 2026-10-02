// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import {
  enterEvConnectedPreSession,
  pushOcspRequestSteps,
  skippedWithoutOcsp,
} from '../../../../ocsp-test-helpers.js';

export const TC_C_51_CSMS: TestCase = {
  id: 'TC_C_51_CSMS',
  name: 'Authorization using Contract Certificates 15118 - Online - Local validation - Rejected',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the CSMS is able to validate the certificate hash data and the provided eMAID.',
  execute: async (ctx) => {
    const ocsp = ctx.ocsp;
    if (ocsp == null) return skippedWithoutOcsp();
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await enterEvConnectedPreSession(ctx);

    // Prerequisites: the configured idToken is known by the CSMS as valid,
    // the contract certificate is revoked, and its responder URL points to the
    // Test System OCSP service. (The PDF's step 3 text says the service
    // "responds that certificate is valid", but the prerequisite and the
    // expected CertificateRevoked make clear it reports revoked.)
    const contract = await ocsp.pki.issueContractCertificate(ctx.tokens.valid);
    ocsp.pki.revoke(contract);

    // Step 1: AuthorizeRequest with <Configured valid_idtoken_idtoken/type>.
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
      iso15118CertificateHashData: ocsp.pki.contractHashData(contract),
    });
    pushOcspRequestSteps(steps, ocsp, contract.cert.serialNumber, 'revoked');

    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown> | undefined)?.['status'];
    const certStatus = authRes['certificateStatus'];
    steps.push({
      step: 4,
      description:
        'AuthorizeResponse idTokenInfo.status Invalid, certificateStatus CertificateRevoked',
      status: authStatus === 'Invalid' && certStatus === 'CertificateRevoked' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Invalid, certificateStatus = CertificateRevoked',
      actual: `idTokenInfo.status = ${String(authStatus)}, certificateStatus = ${String(certStatus)}`,
    });

    // Post scenario: the station does not authorize or charge (the test
    // system sends no TransactionEvent with Authorized or Charging).
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
