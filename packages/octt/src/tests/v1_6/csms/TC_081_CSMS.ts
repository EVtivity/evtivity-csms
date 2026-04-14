// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_081_CSMS: TestCase = {
  id: 'TC_081_CSMS',
  name: 'Secure Firmware Update - Invalid Signature (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point detects an invalid firmware signature.',
  purpose: 'Verify the CSMS handles SignedFirmwareStatusNotification with InvalidSignature.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'SignedUpdateFirmware') {
        received = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SignedUpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
          signingCertificate: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
          signature: 'abc123',
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive SignedUpdateFirmware and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SignedUpdateFirmware.req received',
      actual: received ? 'Received' : 'Not received',
    });

    await ctx.client.sendCall('SignedFirmwareStatusNotification', { status: 'Downloading' });
    await ctx.client.sendCall('SignedFirmwareStatusNotification', { status: 'Downloaded' });
    await ctx.client.sendCall('SignedFirmwareStatusNotification', { status: 'InvalidSignature' });
    steps.push({
      step: 2,
      description: 'Send SignedFirmwareStatusNotification (InvalidSignature)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
