// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_055_CSMS: TestCase = {
  id: 'TC_055_CSMS',
  name: 'Trigger Message - Rejected (1.6)',
  module: 'remote-trigger',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point rejects a triggered message.',
  purpose: 'Verify the CSMS handles Rejected response to TriggerMessage.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let requestedMessage = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'TriggerMessage') {
        received = true;
        requestedMessage = (payload['requestedMessage'] as string) || '';
        return { status: 'Rejected' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'MeterValues',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive TriggerMessage and respond Rejected',
      status: received ? 'passed' : 'failed',
      expected: 'TriggerMessage.req received',
      actual: received
        ? `Received, requestedMessage=${requestedMessage}, responded Rejected`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
