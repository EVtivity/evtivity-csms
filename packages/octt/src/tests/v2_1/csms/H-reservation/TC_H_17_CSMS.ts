// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_H_17_CSMS: Cancel reservation of an EVSE - Success
 *
 * Scenario:
 *   1. CSMS sends ReserveNowRequest
 *   2. Test System responds Accepted
 *   3. StatusNotification Reserved
 *   4. CSMS responds
 *   5. CSMS sends CancelReservationRequest
 *   6. Test System responds Accepted
 *   7. StatusNotification Available
 *   8. CSMS responds
 */
export const TC_H_17_CSMS: TestCase = {
  id: 'TC_H_17_CSMS',
  name: 'Cancel reservation of an EVSE - Success',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to cancel a reservation by sending a CancelReservationRequest to the Charging Station.',
  purpose: 'To verify if the CSMS is able to request the Charging Station to cancel a reservation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot station
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    let receivedReserveNow = false;
    let receivedCancelReservation = false;
    let reservationId = 0;
    let cancelReservationId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          reservationId = Number(payload['id'] ?? 0);
          return { status: 'Accepted' };
        }
        if (action === 'CancelReservation') {
          receivedCancelReservation = true;
          cancelReservationId = Number(payload['reservationId'] ?? 0);
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    // Wait for CSMS to send ReserveNow
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow
        ? `ReserveNowRequest received, reservationId = ${String(reservationId)}`
        : 'No ReserveNowRequest received',
    });

    if (receivedReserveNow) {
      // StatusNotification Reserved
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 2,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });

      // Wait for CSMS to send CancelReservation
      if (ctx.triggerCommand != null) {
        await ctx.triggerCommand('v21', 'CancelReservation', {
          stationId: ctx.stationId,
          reservationId: reservationId,
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      steps.push({
        step: 3,
        description: 'CSMS sends CancelReservationRequest',
        status: receivedCancelReservation ? 'passed' : 'failed',
        expected: 'CancelReservationRequest received',
        actual: receivedCancelReservation
          ? `CancelReservationRequest received, reservationId = ${String(cancelReservationId)}`
          : 'No CancelReservationRequest received',
      });

      if (receivedCancelReservation) {
        // StatusNotification Available
        await ctx.client.sendCall('StatusNotification', {
          timestamp: new Date().toISOString(),
          connectorStatus: 'Available',
          evseId: 1,
          connectorId: 1,
        });

        steps.push({
          step: 4,
          description: 'StatusNotification Available sent after cancellation',
          status: 'passed',
          expected: 'StatusNotificationResponse received',
          actual: 'StatusNotification Available sent',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
