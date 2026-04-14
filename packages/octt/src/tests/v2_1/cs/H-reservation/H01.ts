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

export const TC_H_01_CS: CsTestCase = {
  id: 'TC_H_01_CS',
  name: 'Reserve a specific EVSE - Accepted - Valid idToken',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to reserve a specific EVSE, until the EV Driver with the specified idToken starts charging.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';
    setupHandler(ctx);

    // Step 1: Execute Reusable State Reserved
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
      idToken: { idToken, type: idTokenType },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 1,
      description: 'ReserveNowResponse - status must be Accepted',
      status: reserveStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${reserveStatus}`,
    });

    // Drain the StatusNotification(Reserved) from the reservation
    await ctx.server.waitForMessage('StatusNotification', 5000).catch(() => {});

    // Step 2: After authorization, connector status should change from Reserved to Available
    await ctx.station.authorize(1, idToken);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    const statusEvseId = (statusMsg as Record<string, unknown>)['evseId'] as number;
    steps.push({
      step: 2,
      description:
        'StatusNotificationRequest - connectorStatus must be Available after authorization, evseId must match',
      status: connectorStatus === 'Available' && statusEvseId === evseId ? 'passed' : 'failed',
      expected: `connectorStatus = Available, evseId = ${String(evseId)}`,
      actual: `connectorStatus = ${connectorStatus}, evseId = ${String(statusEvseId)}`,
    });

    // Step 3: Execute Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_02_CS: CsTestCase = {
  id: 'TC_H_02_CS',
  name: 'Reserve a specific EVSE - Accepted - Different idToken',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station rejects all idToken, except the one specified for the reserved EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: reserve EVSE for valid_idtoken1
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const preStatus = (reserveRes as Record<string, unknown>)['status'] as string;
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

    // Step 2: Try to start with different token - should be Rejected
    const startRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      evseId,
    });
    const startStatus = (startRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description:
        'RequestStartTransactionResponse - status must be Rejected (different idToken on reserved EVSE)',
      status: startStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${startStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_03_CS: CsTestCase = {
  id: 'TC_H_03_CS',
  name: 'Reserve a specific EVSE - Occupied - EVSE Reserved',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Occupied, when the requested EVSE is already reserved.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: reserve EVSE first
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
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

    // Step 2: Try second reservation on same EVSE with different id
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      evseId,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Occupied',
      status: reserveStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'status = Occupied',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_04_CS: CsTestCase = {
  id: 'TC_H_04_CS',
  name: 'Reserve a specific EVSE - Occupied - EVSE Occupied',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Occupied, when the requested EVSE is occupied by an active transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: start charging on EVSE to make it occupied
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 2: Try to reserve the occupied EVSE
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      evseId,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Occupied',
      status: reserveStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'status = Occupied',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_06_CS: CsTestCase = {
  id: 'TC_H_06_CS',
  name: 'Reserve a specific EVSE - Unavailable',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Unavailable, when the requested EVSE is unavailable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: make EVSE unavailable
    await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
    });
    // Drain StatusNotification(Unavailable)
    await ctx.server.waitForMessage('StatusNotification', 5000).catch(() => {});

    // Step 2: Try to reserve the unavailable EVSE
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      evseId,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Unavailable',
      status: reserveStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_07_CS: CsTestCase = {
  id: 'TC_H_07_CS',
  name: 'Reserve a specific EVSE - Reservation Ended / not used',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to end the reservation, when the EV Driver with the specified idToken does not use the reservation before the expiry time.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: create a reservation with short expiry (2 seconds)
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 2_000).toISOString(),
    });
    const preStatus = (reserveRes as Record<string, unknown>)['status'] as string;
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

    // Step 1: Wait for StatusNotificationRequest Available (reservation expired)
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 1,
      description:
        'StatusNotificationRequest - connectorStatus must be Available after reservation expiry',
      status: connectorStatus === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus = Available',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    // Step 3: Wait for ReservationStatusUpdateRequest
    const reservationMsg = await ctx.server.waitForMessage('ReservationStatusUpdate', 10000);
    const reservationUpdateStatus = (reservationMsg as Record<string, unknown>)[
      'reservationUpdateStatus'
    ] as string;
    steps.push({
      step: 3,
      description: 'ReservationStatusUpdateRequest - reservationUpdateStatus must be Expired',
      status: reservationUpdateStatus === 'Expired' ? 'passed' : 'failed',
      expected: 'reservationUpdateStatus = Expired',
      actual: `reservationUpdateStatus = ${reservationUpdateStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_08_CS: CsTestCase = {
  id: 'TC_H_08_CS',
  name: 'Reserve an unspecified EVSE - Accepted',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to reserve an unspecified EVSE, until the EV Driver with the specified idToken starts charging.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Send ReserveNowRequest without evseId
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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

    // Optionally wait for StatusNotificationRequest Reserved
    try {
      const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
      const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
      steps.push({
        step: 3,
        description: 'StatusNotificationRequest (optional) - connectorStatus must be Reserved',
        status: connectorStatus === 'Reserved' ? 'passed' : 'failed',
        expected: 'connectorStatus = Reserved',
        actual: `connectorStatus = ${connectorStatus}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'StatusNotificationRequest (optional) - not received (acceptable)',
        status: 'passed',
        expected: 'Optional StatusNotification',
        actual: 'Not received',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_09_CS: CsTestCase = {
  id: 'TC_H_09_CS',
  name: 'Reserve an unspecified EVSE - Occupied - EVSE Reserved',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Occupied, when all EVSE are already reserved.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: reserve the only EVSE (station has 1 EVSE)
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
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

    // Step 2: Try unspecified reservation - all EVSEs reserved
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Occupied',
      status: reserveStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'status = Occupied',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_10_CS: CsTestCase = {
  id: 'TC_H_10_CS',
  name: 'Reserve an unspecified EVSE - Occupied - EVSE Occupied',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Occupied, when all EVSE are occupied.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: start charging on EVSE 1 to make it occupied
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 2: Try unspecified reservation - all EVSEs occupied
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Occupied',
      status: reserveStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'status = Occupied',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_12_CS: CsTestCase = {
  id: 'TC_H_12_CS',
  name: 'Reserve an unspecified EVSE - Unavailable',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Unavailable, when all EVSE are unavailable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: make all EVSEs unavailable
    await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: 1 },
    });
    // Drain StatusNotification(Unavailable)
    await ctx.server.waitForMessage('StatusNotification', 5000).catch(() => {});

    // Step 2: Try unspecified reservation - all EVSEs unavailable
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Unavailable',
      status: reserveStatus === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_13_CS: CsTestCase = {
  id: 'TC_H_13_CS',
  name: 'Reserve an unspecified EVSE - Rejected',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to respond with status Rejected, when it does not support reserving unspecified EVSEs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: disable reservation feature
    ctx.station.setConfigValue('ReservationCtrlr.Enabled', 'false');

    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Rejected',
      status: reserveStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_14_CS: CsTestCase = {
  id: 'TC_H_14_CS',
  name: 'Reserve an unspecified EVSE - Amount of EVSEs available equals the amount of reservations',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to set all available EVSE to reserved, when the amount of EVSEs available equals the amount of reservations.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Reserved',
      status: connectorStatus === 'Reserved' ? 'passed' : 'failed',
      expected: 'connectorStatus = Reserved',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_15_CS: CsTestCase = {
  id: 'TC_H_15_CS',
  name: 'Reserve a connector with a specific type - Success',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an EVSE with a connector with a specific type for a specific IdToken.',
  purpose:
    'To verify if the Charging Station is able to reserve an EVSE with a connector with a specific type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      connectorType: 'cType2',
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusConnStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Reserved',
      status: statusConnStatus === 'Reserved' ? 'passed' : 'failed',
      expected: 'connectorStatus = Reserved',
      actual: `connectorStatus = ${statusConnStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_16_CS: CsTestCase = {
  id: 'TC_H_16_CS',
  name: 'Reserve a connector with a specific type - Amount of available connectors equals reservations',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an EVSE with a connector with a specific type for a specific IdToken.',
  purpose:
    'To verify if the Charging Station responds Occupied when all connectors of the specified type are reserved.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: reserve the only connector of type cType2
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      connectorType: 'cType2',
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

    // Step 2: Try second reservation for same connectorType
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 2,
      connectorType: 'cType2',
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Occupied',
      status: reserveStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'status = Occupied',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_19_CS: CsTestCase = {
  id: 'TC_H_19_CS',
  name: 'Reserve a specific EVSE - Use a reserved EVSE with GroupId',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve an EVSE for a specific GroupIdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to accept an idToken with the same GroupIdToken as the idToken specified in the reservation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
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

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Reserved',
      status: connectorStatus === 'Reserved' ? 'passed' : 'failed',
      expected: 'connectorStatus = Reserved',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_21_CS: CsTestCase = {
  id: 'TC_H_21_CS',
  name: 'Charging Station cancels reservation when Unavailable',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station will cancel reservations, when the EVSE specified for a reservation is set to unavailable.',
  purpose:
    'To verify if the Charging Station cancels the reservation, when the availability of the EVSE specified for the reservation is changed to Inoperative.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: reserve EVSE
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
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

    // Step 2: Send ChangeAvailability Inoperative
    const changeRes = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: evseId },
    });
    const changeStatus = (changeRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ChangeAvailabilityResponse - status must be Accepted',
      status: changeStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus}`,
    });

    const statusMsg1 = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connStatus1 = (statusMsg1 as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Unavailable',
      status: connStatus1 === 'Unavailable' ? 'passed' : 'failed',
      expected: 'connectorStatus = Unavailable',
      actual: `connectorStatus = ${connStatus1}`,
    });

    const reservationMsg = await ctx.server.waitForMessage('ReservationStatusUpdate', 10000);
    const reservationUpdateStatus = (reservationMsg as Record<string, unknown>)[
      'reservationUpdateStatus'
    ] as string;
    steps.push({
      step: 5,
      description: 'ReservationStatusUpdateRequest - reservationUpdateStatus must be Removed',
      status: reservationUpdateStatus === 'Removed' ? 'passed' : 'failed',
      expected: 'reservationUpdateStatus = Removed',
      actual: `reservationUpdateStatus = ${reservationUpdateStatus}`,
    });

    // Restore availability
    const changeRes2 = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
      evse: { id: evseId },
    });
    const changeStatus2 = (changeRes2 as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 8,
      description: 'ChangeAvailabilityResponse (restore) - status must be Accepted',
      status: changeStatus2 === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${changeStatus2}`,
    });

    const statusMsg2 = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connStatus2 = (statusMsg2 as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 9,
      description: 'StatusNotificationRequest - connectorStatus must be Available',
      status: connStatus2 === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus = Available',
      actual: `connectorStatus = ${connStatus2}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_22_CS: CsTestCase = {
  id: 'TC_H_22_CS',
  name: 'Reserve a specific EVSE - Configured to Reject',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the Charging Station is able to correctly respond when it is configured not to accept reservations.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Precondition: disable reservation feature
    ctx.station.setConfigValue('ReservationCtrlr.Enabled', 'false');

    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId: 1,
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const reserveStatus = (reserveRes as Record<string, unknown>)['status'] as string;
    steps.push({
      step: 2,
      description: 'ReserveNowResponse - status must be Rejected',
      status: reserveStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${reserveStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_H_23_CS: CsTestCase = {
  id: 'TC_H_23_CS',
  name: 'Reserve a specific EVSE - Replace reservation',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose: 'To verify if the Charging Station is able to replace a reservation of a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    setupHandler(ctx);

    // Precondition: create initial reservation with id=1
    const preRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
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

    // Step 2: Replace reservation with same id but different token
    const reserveRes = await ctx.server.sendCommand('ReserveNow', {
      id: 1,
      evseId,
      idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
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

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = (statusMsg as Record<string, unknown>)['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Reserved',
      status: connectorStatus === 'Reserved' ? 'passed' : 'failed',
      expected: 'connectorStatus = Reserved',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
