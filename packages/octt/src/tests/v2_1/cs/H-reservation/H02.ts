// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    if (action === 'ReservationStatusUpdate') return {};
    return {};
  });
}

export const TC_H_17_CS: CsTestCase = {
  id: 'TC_H_17_CS',
  name: 'Cancel reservation of an EVSE - Success',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to cancel a reservation by sending a CancelReservationRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to cancel a reservation when receiving a CancelReservationRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const reservationId = 1;
    setupHandler(ctx);

    // Precondition: create a reservation
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: reservationId,
      evseId: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const preStatus = (preRes as Record<string, unknown>)['status'] as string;
    if (preStatus !== 'Accepted') {
      return {
        status: 'error',
        durationMs: 0,
        steps: [],
        error: `Precondition failed: ReserveNow returned ${preStatus}`,
      };
    }
    // Drain StatusNotification(Reserved)
    await ctx.server.waitForMessage('StatusNotification', 5000).catch(() => {});

    // Step 2: Cancel the reservation
    const cancelRes = await ctx.server.sendCommand('CancelReservation', {
      reservationId,
    });
    const cancelStatus = (cancelRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'CancelReservationResponse - status must be Accepted',
      status: cancelStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${cancelStatus}`,
    });

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Available',
      status: connectorStatus === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus = Available',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_18_CS: CsTestCase = {
  id: 'TC_H_18_CS',
  name: 'Cancel reservation of an EVSE - Rejected',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to cancel a reservation by sending a CancelReservationRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to reject a CancelReservationRequest, when there is no matching reservation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const cancelRes = await ctx.server.sendCommand('CancelReservation', {
      reservationId: 1,
    });
    const cancelStatus = (cancelRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'CancelReservationResponse - status must be Rejected',
      status: cancelStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${cancelStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
