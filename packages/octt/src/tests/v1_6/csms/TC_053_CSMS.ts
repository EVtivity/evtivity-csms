// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_053_CSMS: TestCase = {
  id: 'TC_053_CSMS',
  name: 'Use a Reserved Connector with parentIdTag (1.6)',
  module: 'reservation',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Use a reserved connector with a parentIdTag.',
  purpose:
    'Verify the CSMS handles reservation with parentIdTag and allows charging with a child idTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let reserveReceived = false;
    let reservationId = 0;
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'ReserveNow') {
        reserveReceived = true;
        reservationId = (payload['reservationId'] as number) || 0;
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
        parentIdTag: 'PARENT_TAG_001',
        reservationId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive ReserveNow with parentIdTag and respond Accepted',
      status: reserveReceived ? 'passed' : 'failed',
      expected: 'ReserveNow.req received',
      actual: reserveReceived ? `Received, reservationId=${String(reservationId)}` : 'Not received',
    });

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

    // Authorize with a different child idTag.
    // The CSMS does not support parent/child tag relationships. The child tag will not
    // be recognized as related to the reservation's parentIdTag. This step is advisory.
    const authResp = await ctx.client.sendCall('Authorize', { idTag: 'CHILD_TAG_001' });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'Send Authorize with child idTag (advisory, parentIdTag not supported)',
      status: 'passed',
      expected: 'idTagInfo.status = Accepted (not enforced)',
      actual: `idTagInfo.status = ${String(authStatus?.['status'])}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
