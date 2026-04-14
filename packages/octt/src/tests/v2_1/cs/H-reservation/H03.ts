// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

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

export const TC_H_24_CS: CsTestCase = {
  id: 'TC_H_24_CS',
  name: 'Reserve an unspecified EVSE - GroupIdToken',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to reserve an unspecified EVSE, until the EV Driver with the specified GroupIdToken starts charging.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Send ReserveNowRequest with groupIdToken, no evseId
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      groupIdToken: { idToken: 'OCTT-GROUP-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Accepted',
      status: reserveStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${reserveStatus}`,
    });

    // Step 3: Wait for StatusNotificationRequest Reserved
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Reserved',
      status: connectorStatus === 'Reserved' ? 'passed' : 'failed',
      expected: 'connectorStatus = Reserved',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    // Step 5: Execute Reusable State Authorized with different token (valid_idtoken2)
    await ctx.station.authorize(1, 'OCTT-TOKEN-002');

    // Step 6: Execute Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-002');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
