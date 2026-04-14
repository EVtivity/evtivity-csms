// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_052_CSMS: TestCase = {
  id: 'TC_052_CSMS',
  name: 'Cancel Reservation - Rejected (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Cancel reservation rejected by the Charge Point.',
  purpose: 'Verify the CSMS handles Rejected response to CancelReservation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let reserveReceived = false;
    let cancelReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'ReserveNow') {
        reserveReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'CancelReservation') {
        cancelReceived = true;
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
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (reserveReceived) {
      await ctx.client.sendCall('StatusNotification', {
        connectorId: 1,
        status: 'Reserved',
        errorCode: 'NoError',
        timestamp: new Date().toISOString(),
      });
    }

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'CancelReservation', {
        stationId: ctx.stationId,
        reservationId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ReserveNow and respond Accepted',
      status: reserveReceived ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: reserveReceived ? 'Received' : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Receive CancelReservation and respond Rejected',
      status: cancelReceived ? 'passed' : 'failed',
      expected: 'CancelReservation.req received',
      actual: cancelReceived ? 'Received, responded Rejected' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
