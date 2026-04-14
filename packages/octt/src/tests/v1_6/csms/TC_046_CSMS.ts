// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_046_CSMS: TestCase = {
  id: 'TC_046_CSMS',
  name: 'Reservation of a Connector - Transaction (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'A connector is reserved and a charging transaction takes place.',
  purpose: 'Verify the CSMS can send ReserveNow and the station reserves then charges.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let reserveReceived = false;
    let reservationId = 0;
    let reserveIdTag = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ReserveNow') {
        reserveReceived = true;
        reservationId = (payload['reservationId'] as number) || 0;
        reserveIdTag = (payload['idTag'] as string) || '';
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
      actual: reserveReceived ? `Received, reservationId=${String(reservationId)}` : 'Not received',
    });

    // StatusNotification Reserved
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
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

    // Start charging with the reserved idTag
    const idTag = reserveIdTag || 'OCTT_TAG_001';
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
      reservationId,
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'Send StartTransaction with reservationId and expect Accepted',
      status: startTagInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
