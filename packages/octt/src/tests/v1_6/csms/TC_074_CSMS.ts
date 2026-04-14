// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_074_CSMS: TestCase = {
  id: 'TC_074_CSMS',
  name: 'Update Charge Point Certificate by Request of Central System (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System triggers the Charge Point to renew its certificate.',
  purpose:
    'Verify the CSMS can send ExtendedTriggerMessage for SignChargePointCertificate and CertificateSigned.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let extTriggerReceived = false;
    let certSignedReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ExtendedTriggerMessage') {
        extTriggerReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'CertificateSigned') {
        certSignedReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    // Step 1: Trigger the CSMS to send ExtendedTriggerMessage (SignChargePointCertificate)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ExtendedTriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'SignChargePointCertificate',
      });
    }

    // Wait for ExtendedTriggerMessage to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 1,
      description:
        'Receive ExtendedTriggerMessage (SignChargePointCertificate) and respond Accepted',
      status: extTriggerReceived ? 'passed' : 'failed',
      expected: 'ExtendedTriggerMessage.req received',
      actual: extTriggerReceived ? 'Received, responded Accepted' : 'Not received',
    });

    // Step 2: Station sends SignCertificate after receiving the trigger
    if (extTriggerReceived) {
      const signResp = await ctx.client.sendCall('SignCertificate', {
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIBHDCBwwIBADBhMQswCQYDVQQGEwJVUzENMAsGA1UECAwEVGVzdDENMAsGA1UE\nBwwEVGVzdDENMAsGA1UECgwET0NUVDENMAsGA1UECwwET0NUVDEQMA4GA1UEAwwH\nT0NUVF9DUzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJlF9BYzq+U+QRgFOdNg\nKB8pBK0cVF0a+P1WDMiYAoqEMEMmT7L/1h8f+6ASa0VHN3kp/+JV1fVKD0V+cVMM\nF6UwCgYIKoZIzj0EAwIDSAAwRQIhANdHB6xRz+Ym1g7GYFJ8\n-----END CERTIFICATE REQUEST-----',
      });
      const signStatus = signResp['status'] as string;
      steps.push({
        step: 2,
        description: 'Send SignCertificate and expect Accepted',
        status: signStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${signStatus}`,
      });
    }

    // Step 3: Trigger the CSMS to send CertificateSigned with a test certificate chain
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'CertificateSigned', {
        stationId: ctx.stationId,
        certificateChain: '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----',
      });
    }

    // Wait for CertificateSigned to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 3,
      description: 'Receive CertificateSigned and respond Accepted',
      status: certSignedReceived ? 'passed' : 'failed',
      expected: 'CertificateSigned.req received',
      actual: certSignedReceived ? 'Received, responded Accepted' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
