// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import { pushSendAckStep } from '../../../csms-test-helpers.js';

export const TC_047_CSMS: TestCase = {
  id: 'TC_047_CSMS',
  name: 'Reservation of a Connector - Expire (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'A connector is reserved but the reservation expires.',
  purpose: 'Verify the CSMS handles reservation expiry and connector returning to Available.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let reserveReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ReserveNow') {
        reserveReceived = true;
        return { status: 'Accepted' };
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
      description: 'Receive ReserveNow from CSMS and respond Accepted',
      status: reserveReceived ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: reserveReceived ? 'Received' : 'Not received',
    });

    const resp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Reserved',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    pushSendAckStep(steps, 2, 'Send StatusNotification (Reserved)', resp2);

    // Reservation expires
    const resp3 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    pushSendAckStep(steps, 3, 'Send StatusNotification (Available after expiry)', resp3);

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
