// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';

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
    const steps: StepResult[] = [];

    // Step 1: Boot the station
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    // Step 2: Send AuthorizeRequest with valid idToken, iso15118CertificateHashData absent
    // Central validation path: CSMS validates the certificate itself
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-EMAID-001', type: 'eMAID' },
      certificate: 'MIIBkTCB+wIJALRiMLAh0DGRAMAKB...',
    });

    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const authStatus = idTokenInfo?.['status'] as string | undefined;
    const certStatus = authRes['certificateStatus'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Send AuthorizeRequest with eMAID and certificate (central validation)',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(authStatus)}`,
    });

    steps.push({
      step: 3,
      description: 'Verify certificateStatus is Accepted',
      status: certStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'certificateStatus = Accepted',
      actual: `certificateStatus = ${String(certStatus)}`,
    });

    // Step 4: Send TransactionEvent with triggerReason Authorized
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-EMAID-001', type: 'eMAID' },
    });

    const txIdTokenInfo = txRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const txAuthStatus = txIdTokenInfo?.['status'] as string | undefined;

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Started with triggerReason Authorized',
      status: txAuthStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(txAuthStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
