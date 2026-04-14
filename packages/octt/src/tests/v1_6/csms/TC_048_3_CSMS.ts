// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_048_3_CSMS: TestCase = {
  id: 'TC_048_3_CSMS',
  name: 'Reservation of a Connector - Unavailable (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reservation attempt when connector is unavailable.',
  purpose: 'Verify the CSMS handles Unavailable response to ReserveNow after ChangeAvailability.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let changeAvailReceived = false;
    let reserveReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ChangeAvailability') {
        changeAvailReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'ReserveNow') {
        reserveReceived = true;
        return { status: 'Unavailable' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ChangeAvailability', {
        stationId: ctx.stationId,
        connectorId: 1,
        type: 'Inoperative',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // Send Unavailable status
    if (changeAvailReceived) {
      await ctx.client.sendCall('StatusNotification', {
        connectorId,
        status: 'Unavailable',
        errorCode: 'NoError',
        timestamp: new Date().toISOString(),
      });
    }

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
      description: 'Receive ChangeAvailability and set connector Unavailable',
      status: changeAvailReceived ? 'passed' : 'failed',
      expected: 'ChangeAvailability.req received',
      actual: changeAvailReceived ? 'Received' : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Receive ReserveNow and respond Unavailable',
      status: reserveReceived ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: reserveReceived ? 'Received, responded Unavailable' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
