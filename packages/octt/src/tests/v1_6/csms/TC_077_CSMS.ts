// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_077_CSMS: TestCase = {
  id: 'TC_077_CSMS',
  name: 'Invalid ChargePointCertificate Security Event (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point notifies the Central System of an invalid certificate.',
  purpose: 'Verify the CSMS handles SecurityEventNotification for InvalidChargePointCertificate.',
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
        return { status: 'Rejected' };
      }
      return {};
    });

    // Step 1: Trigger ExtendedTriggerMessage
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ExtendedTriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'SignChargePointCertificate',
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 1,
      description: 'Receive ExtendedTriggerMessage and respond Accepted',
      status: extTriggerReceived ? 'passed' : 'failed',
      expected: 'ExtendedTriggerMessage.req received',
      actual: extTriggerReceived ? 'Received' : 'Not received',
    });

    // Step 2: Station sends SignCertificate after trigger
    if (extTriggerReceived) {
      await ctx.client.sendCall('SignCertificate', {
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIBtest\n-----END CERTIFICATE REQUEST-----',
      });
    }

    // Trigger the CSMS to send CertificateSigned with an invalid certificate
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'CertificateSigned', {
        stationId: ctx.stationId,
        certificateChain: '-----BEGIN CERTIFICATE-----\nINVALID\n-----END CERTIFICATE-----',
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    steps.push({
      step: 2,
      description: 'Receive CertificateSigned and respond Rejected (invalid cert)',
      status: certSignedReceived ? 'passed' : 'failed',
      expected: 'CertificateSigned.req received',
      actual: certSignedReceived ? 'Received, responded Rejected' : 'Not received',
    });

    // Step 3: Send SecurityEventNotification for the invalid certificate
    const secResp = await ctx.client.sendCall('SecurityEventNotification', {
      type: 'InvalidChargePointCertificate',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send SecurityEventNotification (InvalidChargePointCertificate)',
      status: secResp !== undefined ? 'passed' : 'failed',
      expected: 'SecurityEventNotification.conf received',
      actual: secResp !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
