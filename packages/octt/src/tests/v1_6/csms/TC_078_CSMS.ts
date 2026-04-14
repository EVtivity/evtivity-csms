// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_078_CSMS: TestCase = {
  id: 'TC_078_CSMS',
  name: 'Invalid CentralSystemCertificate Security Event (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point rejects an installed certificate and sends a security event.',
  purpose: 'Verify the CSMS handles SecurityEventNotification for InvalidCentralSystemCertificate.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let installReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'InstallCertificate') {
        installReceived = true;
        return { status: 'Rejected' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'InstallCertificate', {
        stationId: ctx.stationId,
        certificateType: 'CentralSystemRootCertificate',
        certificate: '-----BEGIN CERTIFICATE-----\nMIIBxx...\n-----END CERTIFICATE-----',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive InstallCertificate and respond Rejected',
      status: installReceived ? 'passed' : 'failed',
      expected: 'InstallCertificate.req received',
      actual: installReceived ? 'Received, responded Rejected' : 'Not received',
    });

    const secResp = await ctx.client.sendCall('SecurityEventNotification', {
      type: 'InvalidCentralSystemCertificate',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 2,
      description: 'Send SecurityEventNotification (InvalidCentralSystemCertificate)',
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
