// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import { OCTT_CSR, OCTT_SIGNED_CERTIFICATE_CHAIN } from '../../../../certificate-fixtures.js';
import { signPendingCsr, waitFor } from '../../../../security-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

export const TC_A_12_CSMS: TestCase = {
  id: 'TC_A_12_CSMS',
  name: 'Update Charging Station Certificate by request of CSMS - Success - V2G Certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests the Charging Station to update its V2G certificate using the TriggerMessage and CertificateSigned flow.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to update its V2G Certificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot the station first
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 1: The CSMS sends a TriggerMessageRequest for SignV2GCertificate.
    let triggerMessageReceived = false;
    let triggerRequestedMessage = '';
    let certificateSignedReceived = false;

    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'TriggerMessage') {
        triggerMessageReceived = true;
        triggerRequestedMessage = String(payload['requestedMessage'] ?? '');
        return { status: 'Accepted' };
      }
      if (action === 'CertificateSigned') {
        certificateSignedReceived = true;
        return { status: 'Accepted' };
      }
      return defaultReply('ocpp2.1', action, payload);
    });

    // Wait for the CSMS to send TriggerMessage
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'SignV2GCertificate',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (triggerMessageReceived) {
      // Step 2: Respond with TriggerMessageResponse Accepted (handled above).
      steps.push({
        step: 1,
        description: 'CSMS sends TriggerMessageRequest for SignV2GCertificate',
        status: triggerRequestedMessage === 'SignV2GCertificate' ? 'passed' : 'failed',
        expected: 'requestedMessage = SignV2GCertificate',
        actual: `requestedMessage = ${triggerRequestedMessage}`,
      });

      // Step 3: Send SignCertificateRequest with V2GCertificate type
      const signRes = await ctx.client.sendCall('SignCertificate', {
        csr: OCTT_CSR,
        certificateType: 'V2GCertificate',
      });

      // Step 4: CSMS responds with SignCertificateResponse
      const signStatus = signRes['status'] as string;
      steps.push({
        step: 2,
        description: 'CSMS responds to SignCertificateRequest with status Accepted',
        status: signStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${signStatus}`,
      });

      // Step 5-6: CSMS sends CertificateSignedRequest, we respond with Accepted
      // Manual action: the operator signs the queued CSR (manual PKI provider).
      // A rejected CSR is not queued, so there is nothing to sign.
      const signError =
        signStatus === 'Accepted'
          ? await signPendingCsr(ctx, OCTT_SIGNED_CERTIFICATE_CHAIN)
          : `Not signed: SignCertificateResponse status = ${signStatus}`;
      if (signError == null) await waitFor(() => certificateSignedReceived);

      steps.push({
        step: 3,
        description: 'CSMS sends CertificateSignedRequest with signed V2G certificate',
        status: certificateSignedReceived ? 'passed' : 'failed',
        expected: 'CertificateSignedRequest received',
        actual: certificateSignedReceived
          ? 'CertificateSignedRequest received'
          : (signError ?? 'No CertificateSignedRequest within timeout'),
      });
    } else {
      steps.push({
        step: 1,
        description: 'CSMS sends TriggerMessageRequest',
        status: 'failed',
        expected: 'TriggerMessageRequest received',
        actual: 'No TriggerMessageRequest received within timeout',
      });
    }

    // Post scenario: verify connection is still active
    steps.push({
      step: 4,
      description: 'Test System and CSMS remain connected',
      status: ctx.client.isConnected ? 'passed' : 'failed',
      expected: 'Connected',
      actual: ctx.client.isConnected ? 'Connected' : 'Disconnected',
    });

    return {
      status: steps.every((s) => s.status !== 'failed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
