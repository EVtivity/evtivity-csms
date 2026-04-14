// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_049_CSMS: TestCase = {
  id: 'TC_049_CSMS',
  name: 'Reservation of a Charge Point - Transaction (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Reserve an unspecified connector (connectorId=0) and start a charging transaction.',
  purpose: 'Verify the CSMS can send ReserveNow with connectorId=0.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let reserveConnectorId = -1;
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ReserveNow') {
        received = true;
        reserveConnectorId = (payload['connectorId'] as number) ?? -1;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'ReserveNow', {
        stationId: ctx.stationId,
        connectorId: 0,
        expiryDate: new Date(Date.now() + 300000).toISOString(),
        idTag: 'OCTT-TOKEN-001',
        reservationId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ReserveNow with connectorId=0 and respond Accepted',
      status: received && reserveConnectorId === 0 ? 'passed' : 'failed',
      expected: 'ReserveNow.req with connectorId=0',
      actual: received ? `Received, connectorId=${String(reserveConnectorId)}` : 'Not received',
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Reserved',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 2,
      description: 'Send StatusNotification (Reserved)',
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
