// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_048_4_CSMS: TestCase = {
  id: 'TC_048_4_CSMS',
  name: 'Reservation of a Connector - Rejected (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reservation attempt rejected by the Charge Point.',
  purpose: 'Verify the CSMS handles Rejected response to ReserveNow.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ReserveNow') {
        received = true;
        return { status: 'Rejected' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ReserveNow', {
        stationId: ctx.stationId,
        connectorId: 1,
        expiryDate: new Date(Date.now() + 300000).toISOString(),
        idTag: 'OCTT-TOKEN-001',
        reservationId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ReserveNow from CSMS and respond Rejected',
      status: received ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: received ? 'Received, responded Rejected' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
