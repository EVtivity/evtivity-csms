// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_048_2_CSMS: TestCase = {
  id: 'TC_048_2_CSMS',
  name: 'Reservation of a Connector - Occupied (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reservation attempt when connector is occupied.',
  purpose: 'Verify the CSMS handles Occupied response to ReserveNow.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Send Preparing (cable plugged in)
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 1,
      description: 'Send StatusNotification (Preparing)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ReserveNow') {
        received = true;
        return { status: 'Occupied' };
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
      step: 2,
      description: 'Receive ReserveNow from CSMS and respond Occupied',
      status: received ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: received ? 'Received, responded Occupied' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
