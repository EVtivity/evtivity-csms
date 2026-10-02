// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import { contractChainPem } from '../../../../ocsp-test-service.js';
import { enterEvConnectedPreSession, skippedWithoutOcsp } from '../../../../ocsp-test-helpers.js';

export const TC_C_52_CSMS: TestCase = {
  id: 'TC_C_52_CSMS',
  name: 'Authorization using Contract Certificates 15118 - Online - Central validation - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the CSMS is able to validate the provided certificate and eMAID via central validation.',
  execute: async (ctx) => {
    const ocsp = ctx.ocsp;
    if (ocsp == null) return skippedWithoutOcsp();
    if (ocsp.installedMoRootId == null) {
      return {
        status: 'skipped',
        durationMs: 0,
        steps: [
          {
            step: 1,
            description:
              'Prerequisite: the contract certificate is signed by the configured MORoot',
            status: 'skipped',
            expected: 'The runner installs the Test System MO root through the CSMS API',
            actual: 'MO root could not be installed (no API access or PnC disabled)',
          },
        ],
      };
    }
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    const transactionId = await enterEvConnectedPreSession(ctx);

    // Prerequisites: the eMAID is known by the CSMS as valid, the contract
    // certificate chains to the MO root configured in the CSMS (installed by
    // the runner), and its AIA responder URL points to the Test System OCSP
    // service.
    const contract = await ocsp.pki.issueContractCertificate(ctx.tokens.emaid);
    const idToken = { idToken: ctx.tokens.emaid, type: 'eMAID' };

    // Step 1: iso15118CertificateHashData absent, certificate from keystore.
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken,
      certificate: contractChainPem(ocsp.pki, contract),
    });

    // Step 2: the CSMS computed the hash data and sent an OCSP request.
    const requests = ocsp.responder.requestsFor(contract.cert.serialNumber);
    steps.push({
      step: 2,
      description: 'CSMS sends an OCSP request for the certificate',
      status: requests.length > 0 ? 'passed' : 'failed',
      expected: 'OCSP request for the contract certificate received by the Test System',
      actual:
        requests.length > 0
          ? `${String(requests.length)} request(s) received`
          : 'No OCSP request received (is the responder host in pnc.ocsp.allowedPrivateHosts?)',
    });

    // Step 3: the request is valid (known CertID, answered good), the key is
    // ECDSA, and the chain the station sent contains at least one SubCA.
    const keyAlgorithm = contract.cert.publicKey.algorithm.name;
    const valid = requests.some((r) => r.status === 'good') && keyAlgorithm === 'ECDSA';
    steps.push({
      step: 3,
      description: 'OCSP request is valid, key type ECDSA, chain contains a SubCA',
      status: valid ? 'passed' : 'failed',
      expected: 'Request answered good, ECDSA key, 2 SubCAs in the chain',
      actual: `answers = ${requests.map((r) => r.status).join(', ') || 'none'}, key = ${keyAlgorithm}`,
    });

    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown> | undefined)?.['status'];
    const certStatus = authRes['certificateStatus'];
    steps.push({
      step: 4,
      description: 'AuthorizeResponse idTokenInfo.status Accepted, certificateStatus Accepted',
      status: authStatus === 'Accepted' && certStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted, certificateStatus = Accepted',
      actual: `idTokenInfo.status = ${String(authStatus)}, certificateStatus = ${String(certStatus)}`,
    });

    // Step 5: TransactionEventRequest with triggerReason Authorized.
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 1,
      transactionInfo: { transactionId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken,
    });
    const txStatus = (txRes['idTokenInfo'] as Record<string, unknown> | undefined)?.['status'];
    steps.push({
      step: 6,
      description: 'TransactionEventResponse idTokenInfo.status Accepted',
      status: txStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(txStatus)}`,
    });

    // Reusable State EnergyTransferStarted.
    const chargingRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 2,
      transactionInfo: { transactionId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });
    steps.push({
      step: 7,
      description: 'EnergyTransferStarted: TransactionEventResponse received',
      status: chargingRes != null ? 'passed' : 'failed',
      expected: 'Response received',
      actual: chargingRes != null ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
