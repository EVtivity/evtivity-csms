// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import {
  enterEvConnectedPreSession,
  pushOcspRequestSteps,
  skippedWithoutOcsp,
} from '../../../../ocsp-test-helpers.js';

export const TC_C_50_CSMS: TestCase = {
  id: 'TC_C_50_CSMS',
  name: 'Authorization using Contract Certificates 15118 - Online - Local validation - Accepted',
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
    const transactionId = await enterEvConnectedPreSession(ctx);

    // Prerequisites: the configured eMAID is known by the CSMS as valid
    // (ctx.tokens.emaid), the contract certificate is valid and its CN is the
    // eMAID, and its responder URL points to the Test System OCSP service.
    const contract = await ocsp.pki.issueContractCertificate(ctx.tokens.emaid);
    const emaid = { idToken: ctx.tokens.emaid, type: 'eMAID' };

    // Step 1: AuthorizeRequest with the eMAID and the chain's hash data.
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: emaid,
      iso15118CertificateHashData: ocsp.pki.contractHashData(contract),
    });
    pushOcspRequestSteps(steps, ocsp, contract.cert.serialNumber, 'good');

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
      idToken: emaid,
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

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
