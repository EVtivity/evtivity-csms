// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

const HANDLER = async (action: string) => {
  if (action === 'BootNotification')
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
  if (action === 'StatusNotification') return {};
  if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
  if (action === 'StartTransaction') return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
  if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  return {};
};

const makeReserveTest = (
  id: string,
  name: string,
  expectedStatus: string,
  connectorId: number,
): CsTestCase => ({
  id,
  name,
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: `Reservation test - expected ${expectedStatus}.`,
  purpose: `Check whether the Charge Point responds with ${expectedStatus} for ReserveNow.`,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);

    // Set up precondition based on expected status
    if (expectedStatus === 'Faulted') {
      await ctx.station.injectFault(1, 'GroundFailure');
      // Drain StatusNotification from fault injection
      for (let _d = 0; _d < 5; _d++) {
        try {
          await ctx.server.waitForMessage('StatusNotification', 500);
        } catch {
          break;
        }
      }
    } else if (expectedStatus === 'Occupied') {
      await ctx.station.plugIn(1);
      await ctx.station.startCharging(1, 'OCTT_TAG_001');
      for (let _d = 0; _d < 10; _d++) {
        try {
          await ctx.server.waitForMessage('StatusNotification', 500);
        } catch {
          break;
        }
      }
      try {
        await ctx.server.waitForMessage('StartTransaction', 500);
      } catch {
        /* drain */
      }
      try {
        await ctx.server.waitForMessage('Authorize', 500);
      } catch {
        /* drain */
      }
    } else if (expectedStatus === 'Unavailable') {
      await ctx.server.sendCommand('ChangeAvailability', { connectorId: 1, type: 'Inoperative' });
      for (let _d = 0; _d < 5; _d++) {
        try {
          await ctx.server.waitForMessage('StatusNotification', 500);
        } catch {
          break;
        }
      }
    } else if (expectedStatus === 'Rejected') {
      // Prerequisite: station does NOT support Reservation feature
      ctx.station.setConfigValue(
        'SupportedFeatureProfiles',
        'Core,FirmwareManagement,LocalAuthListManagement,SmartCharging,RemoteTrigger',
      );
    }

    const resp = await ctx.server.sendCommand('ReserveNow', {
      connectorId,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      reservationId: 1,
    });
    steps.push({
      step: 2,
      description: `ReserveNow ${expectedStatus}`,
      status: (resp['status'] as string) === expectedStatus ? 'passed' : 'failed',
      expected: `status = ${expectedStatus}`,
      actual: `status = ${String(resp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
});

export const TC_046_1_CS: CsTestCase = {
  id: 'TC_046_1_CS',
  name: 'Reservation of a Connector - Local start transaction',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'A Connector is reserved and a charging transaction takes place.',
  purpose: 'Check whether the Charge Point can reserve a Connector.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    const resp = await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      reservationId: 1,
    });
    steps.push({
      step: 2,
      description: 'ReserveNow Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Reserved',
      status: (sn1['status'] as string) === 'Reserved' ? 'passed' : 'failed',
      expected: 'status = Reserved',
      actual: `status = ${String(sn1['status'])}`,
    });
    await ctx.station.authorize(1, 'OCTT_TAG_001');
    await ctx.station.plugIn(1);
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    const resId = startTx['reservationId'] as number | undefined;
    steps.push({
      step: 10,
      description: 'StartTransaction with reservationId',
      status: resId === 1 ? 'passed' : 'failed',
      expected: 'reservationId = 1',
      actual: `reservationId = ${String(resId)}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_046_2_CS = makeReserveTest(
  'TC_046_2_CS',
  'Reservation of a Connector - Remote start transaction',
  'Accepted',
  1,
);
export const TC_047_CS: CsTestCase = {
  id: 'TC_047_CS',
  name: 'Reservation of a Connector - Expire',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'A Connector is reserved but the reservation expires.',
  purpose: 'Check whether the Charge Point handles reservation expiry.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    const resp = await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 10_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      reservationId: 1,
    });
    steps.push({
      step: 2,
      description: 'ReserveNow Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Reserved',
      status: (sn1['status'] as string) === 'Reserved' ? 'passed' : 'failed',
      expected: 'status = Reserved',
      actual: `status = ${String(sn1['status'])}`,
    });
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Available after expiry',
      status: (sn2['status'] as string) === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn2['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
export const TC_048_1_CS = makeReserveTest(
  'TC_048_1_CS',
  'Reservation of a Connector - Faulted',
  'Faulted',
  1,
);
export const TC_048_2_CS = makeReserveTest(
  'TC_048_2_CS',
  'Reservation of a Connector - Occupied',
  'Occupied',
  1,
);
export const TC_048_3_CS = makeReserveTest(
  'TC_048_3_CS',
  'Reservation of a Connector - Unavailable',
  'Unavailable',
  1,
);
export const TC_048_4_CS = makeReserveTest(
  'TC_048_4_CS',
  'Reservation of a Connector - Rejected',
  'Rejected',
  1,
);
export const TC_049_CS = makeReserveTest(
  'TC_049_CS',
  'Reservation of a Charge Point - Transaction',
  'Accepted',
  0,
);
export const TC_050_1_CS = makeReserveTest(
  'TC_050_1_CS',
  'Reservation of a Charge Point - Faulted',
  'Faulted',
  0,
);
export const TC_050_2_CS = makeReserveTest(
  'TC_050_2_CS',
  'Reservation of a Charge Point - Occupied',
  'Occupied',
  0,
);
export const TC_050_3_CS = makeReserveTest(
  'TC_050_3_CS',
  'Reservation of a Charge Point - Unavailable',
  'Unavailable',
  0,
);
export const TC_050_4_CS = makeReserveTest(
  'TC_050_4_CS',
  'Reservation of a Charge Point - Rejected',
  'Rejected',
  0,
);

export const TC_051_CS: CsTestCase = {
  id: 'TC_051_CS',
  name: 'Cancel Reservation',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System cancels an existing, not expired reservation.',
  purpose: 'Check whether the Charge Point is able to cancel a reservation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      reservationId: 1,
    });
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* consumed */
    }
    const cancelResp = await ctx.server.sendCommand('CancelReservation', { reservationId: 1 });
    steps.push({
      step: 2,
      description: 'CancelReservation Accepted',
      status: (cancelResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(cancelResp['status'])}`,
    });
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Available',
      status: (sn['status'] as string) === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_052_CS: CsTestCase = {
  id: 'TC_052_CS',
  name: 'Cancel Reservation - Rejected',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System tries to cancel a reservation with wrong reservationId.',
  purpose: 'Check whether the Charge Point rejects cancel with wrong reservationId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      reservationId: 1,
    });
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* consumed */
    }
    const cancelResp = await ctx.server.sendCommand('CancelReservation', { reservationId: 99999 });
    steps.push({
      step: 2,
      description: 'CancelReservation Rejected',
      status: (cancelResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(cancelResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_053_1_CS: CsTestCase = {
  id: 'TC_053_1_CS',
  name: 'Use a reserved Connector with parentIdTag - Local',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point has been reserved and is used with a parentIdTag.',
  purpose: 'Check whether the Charge Point handles reservation with parentIdTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    const resp = await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      parentIdTag: 'OCTT_PARENT_001',
      reservationId: 1,
    });
    steps.push({
      step: 2,
      description: 'ReserveNow Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Reserved',
      status: (sn['status'] as string) === 'Reserved' ? 'passed' : 'failed',
      expected: 'status = Reserved',
      actual: `status = ${String(sn['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_053_2_CS: CsTestCase = {
  id: 'TC_053_2_CS',
  name: 'Use a reserved Connector with parentIdTag - Remote',
  module: '21-reservation',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point has been reserved and is used with a parentIdTag (remote).',
  purpose: 'Check whether the Charge Point handles reservation with parentIdTag (remote start).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(HANDLER);
    const resp = await ctx.server.sendCommand('ReserveNow', {
      connectorId: 1,
      expiryDate: new Date(Date.now() + 300_000).toISOString(),
      idTag: 'OCTT_TAG_001',
      parentIdTag: 'OCTT_PARENT_001',
      reservationId: 1,
    });
    steps.push({
      step: 2,
      description: 'ReserveNow Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Reserved',
      status: (sn['status'] as string) === 'Reserved' ? 'passed' : 'failed',
      expected: 'status = Reserved',
      actual: `status = ${String(sn['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
