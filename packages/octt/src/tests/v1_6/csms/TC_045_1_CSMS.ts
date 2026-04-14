// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_045_1_CSMS: TestCase = {
  id: 'TC_045_1_CSMS',
  name: 'Get Diagnostics (1.6)',
  module: 'firmware',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point uploads a diagnostics log based on CSMS request.',
  purpose: 'Verify the CSMS can trigger GetDiagnostics and handle upload status notifications.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'GetDiagnostics') {
        received = true;
        return { fileName: 'diagnostics-log.txt' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'GetDiagnostics', {
        stationId: ctx.stationId,
        location: 'https://example.com/upload',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetDiagnostics from CSMS',
      status: received ? 'passed' : 'failed',
      expected: 'GetDiagnostics.req received',
      actual: received ? 'Received, responded with fileName' : 'Not received',
    });

    await ctx.client.sendCall('DiagnosticsStatusNotification', { status: 'Uploading' });
    steps.push({
      step: 2,
      description: 'Send DiagnosticsStatusNotification (Uploading)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    await ctx.client.sendCall('DiagnosticsStatusNotification', { status: 'Uploaded' });
    steps.push({
      step: 3,
      description: 'Send DiagnosticsStatusNotification (Uploaded)',
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
