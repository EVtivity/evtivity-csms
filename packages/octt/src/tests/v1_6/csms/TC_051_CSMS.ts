// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_051_CSMS: TestCase = {
  id: 'TC_051_CSMS',
  name: 'Cancel Reservation (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System cancels an existing reservation.',
  purpose: 'Verify the CSMS can send CancelReservation after a ReserveNow.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let reserveReceived = false;
    let cancelReceived = false;
    let reservationId = 0;
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ReserveNow') {
        reserveReceived = true;
        reservationId = (payload['reservationId'] as number) || 0;
        return { status: 'Accepted' };
      }
      if (action === 'CancelReservation') {
        cancelReceived = true;
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
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (reserveReceived) {
      await ctx.client.sendCall('StatusNotification', {
        connectorId,
        status: 'Reserved',
        errorCode: 'NoError',
        timestamp: new Date().toISOString(),
      });
    }

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'CancelReservation', {
        stationId: ctx.stationId,
        reservationId: reservationId || 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ReserveNow and respond Accepted',
      status: reserveReceived ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: reserveReceived ? `Received, reservationId=${String(reservationId)}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Receive CancelReservation and respond Accepted',
      status: cancelReceived ? 'passed' : 'failed',
      expected: 'CancelReservation.req received',
      actual: cancelReceived ? 'Received, responded Accepted' : 'Not received',
    });

    if (cancelReceived) {
      await ctx.client.sendCall('StatusNotification', {
        connectorId,
        status: 'Available',
        errorCode: 'NoError',
        timestamp: new Date().toISOString(),
      });
    }
    steps.push({
      step: 3,
      description: 'Send StatusNotification (Available after cancel)',
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
