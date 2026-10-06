// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StationConfig } from '../station-simulator.js';
import {
  makeHarness,
  priv,
  silenceConsole,
  stubSql,
  type Harness,
  type HarnessOptions,
} from './sim-harness.js';

const TWO_EVSES: Partial<StationConfig> = {
  evses: [
    {
      evseId: 1,
      connectorId: 1,
      connectorType: 'ac_type2',
      maxPowerW: 22000,
      phases: 3,
      voltage: 230,
    },
    {
      evseId: 2,
      connectorId: 1,
      connectorType: 'dc_ccs2',
      maxPowerW: 50000,
      phases: 3,
      voltage: 400,
    },
  ],
};

function inOneHour(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

function statusOf(h: Harness, evseId: number): string | undefined {
  return (priv(h, 'evseConnectorStatus') as Map<number, string>).get(evseId);
}

function reservations(h: Harness): Map<number, Record<string, unknown>> {
  return priv(h, 'reservations') as Map<number, Record<string, unknown>>;
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ReserveNow (OCPP 2.1)', () => {
  it('accepts a reservation for a free EVSE, marks it Reserved and notifies the CSMS', async () => {
    const h = await makeHarness();
    const res = await h.invoke('ReserveNow', {
      id: 7,
      evseId: 1,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(reservations(h).get(7)).toMatchObject({ id: 7, evseId: 1, idToken: 'TAG-1' });
    expect(statusOf(h, 1)).toBe('Reserved');
    await vi.advanceTimersByTimeAsync(0);
    const status = h.sent('StatusNotification').at(-1);
    expect(status).toMatchObject({ evseId: 1, connectorId: 1, connectorStatus: 'Reserved' });
  });

  it('is rejected when ReservationCtrlr.Enabled is false', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('ReservationCtrlr.Enabled', 'false');
    const res = await h.invoke('ReserveNow', {
      id: 1,
      evseId: 1,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'UnavailableReservation' },
    });
    expect(reservations(h).size).toBe(0);
  });

  it.each([
    ['Faulted', 'Faulted'],
    ['Unavailable', 'Unavailable'],
    ['Charging', 'Occupied'],
    ['Occupied', 'Occupied'],
  ])('answers %s connector with %s', async (connector, expected) => {
    const h = await makeHarness();
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, connector);
    const res = await h.invoke('ReserveNow', {
      id: 2,
      evseId: 1,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res['status']).toBe(expected);
    expect(reservations(h).has(2)).toBe(false);
  });

  it('answers Occupied with TransactionInProgress when a transaction is active', async () => {
    const sql = stubSql((q) =>
      q.includes('transaction_id') && q.includes("status = 'active'")
        ? [{ transaction_id: 'tx-9', meter_start_wh: 0, id_token: 'X' }]
        : undefined,
    );
    const h = await makeHarness({ sql });
    const res = await h.invoke('ReserveNow', {
      id: 3,
      evseId: 1,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res).toEqual({
      status: 'Occupied',
      statusInfo: { reasonCode: 'TransactionInProgress' },
    });
  });

  it('answers Occupied when another reservation already holds the EVSE', async () => {
    const h = await makeHarness();
    const base = { evseId: 1, expiryDateTime: inOneHour() };
    await h.invoke('ReserveNow', { id: 1, idToken: { idToken: 'A', type: 'ISO14443' }, ...base });
    // Clear the Reserved status so the reservation check (not the status check) decides.
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, 'Available');
    const res = await h.invoke('ReserveNow', {
      id: 2,
      idToken: { idToken: 'B', type: 'ISO14443' },
      ...base,
    });
    expect(res).toEqual({ status: 'Occupied' });
  });

  it('replaces a reservation with the same id', async () => {
    const h = await makeHarness(TWO_EVSES_OPTS());
    await h.invoke('ReserveNow', {
      id: 5,
      evseId: 1,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    const res = await h.invoke('ReserveNow', {
      id: 5,
      evseId: 2,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res['status']).toBe('Accepted');
    expect(reservations(h).size).toBe(1);
    expect(reservations(h).get(5)?.['evseId']).toBe(2);
  });

  it('assigns the first free EVSE of the requested connector type when evseId is omitted', async () => {
    const h = await makeHarness(TWO_EVSES_OPTS());
    const res = await h.invoke('ReserveNow', {
      id: 11,
      connectorType: 'cCCS2',
      idToken: { idToken: 'A', type: 'ISO14443' },
      groupIdToken: { idToken: 'GROUP', type: 'Central' },
      expiryDateTime: inOneHour(),
    });
    expect(res['status']).toBe('Accepted');
    expect(reservations(h).get(11)).toMatchObject({
      evseId: 2,
      connectorType: 'cCCS2',
      groupIdToken: 'GROUP',
    });
    expect(statusOf(h, 2)).toBe('Reserved');
    expect(statusOf(h, 1)).not.toBe('Reserved');
  });

  it('answers Occupied for an any-EVSE reservation when every EVSE is busy or reserved', async () => {
    const h = await makeHarness(TWO_EVSES_OPTS());
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, 'Charging');
    await h.invoke('ReserveNow', {
      id: 1,
      evseId: 2,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    const res = await h.invoke('ReserveNow', {
      id: 2,
      idToken: { idToken: 'B', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(res).toEqual({ status: 'Occupied' });
  });

  it('answers Faulted or Unavailable for an any-EVSE reservation', async () => {
    const h = await makeHarness(TWO_EVSES_OPTS());
    const st = priv(h, 'evseConnectorStatus') as Map<number, string>;
    st.set(1, 'Unavailable');
    st.set(2, 'Unavailable');
    const payload = {
      id: 1,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    };
    expect(await h.invoke('ReserveNow', payload)).toEqual({ status: 'Unavailable' });
    st.set(2, 'Faulted');
    expect(await h.invoke('ReserveNow', payload)).toEqual({ status: 'Faulted' });
  });

  it('expires: removes the reservation, reports Expired and Available', async () => {
    const h = await makeHarness();
    await h.invoke('ReserveNow', {
      id: 9,
      evseId: 1,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 5_000).toISOString(),
    });
    expect(reservations(h).has(9)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(reservations(h).has(9)).toBe(false);
    expect(h.sent('ReservationStatusUpdate')).toContainEqual({
      reservationId: 9,
      reservationUpdateStatus: 'Expired',
    });
    expect(h.sent('StatusNotification').at(-1)?.['connectorStatus']).toBe('Available');
    expect(statusOf(h, 1)).toBe('Available');
  });
});

describe('ReserveNow (OCPP 1.6)', () => {
  it('is rejected when the Reservation feature profile is not supported', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sim.setConfigValue('SupportedFeatureProfiles', 'Core,SmartCharging');
    const res = await h.invoke('ReserveNow', {
      reservationId: 1,
      connectorId: 1,
      idTag: 'TAG',
      expiryDate: inOneHour(),
    });
    expect(res).toEqual({ status: 'Rejected' });
  });

  it('accepts with 1.6 field names and reports Reserved with the 1.6 StatusNotification shape', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sim.setConfigValue('SupportedFeatureProfiles', 'Core,Reservation');
    const res = await h.invoke('ReserveNow', {
      reservationId: 4,
      connectorId: 1,
      idTag: 'TAG',
      expiryDate: inOneHour(),
    });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('StatusNotification').at(-1)).toEqual({
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Reserved',
    });
    // 1.6 has no ReservationStatusUpdate.
    const cancel = await h.invoke('CancelReservation', { reservationId: 4 });
    expect(cancel).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('ReservationStatusUpdate')).toHaveLength(0);
  });

  it('answers Occupied without statusInfo when a transaction is active', async () => {
    const sql = stubSql((q) =>
      q.includes('transaction_id') && q.includes("status = 'active'")
        ? [{ transaction_id: '12', meter_start_wh: 0, id_token: 'X' }]
        : undefined,
    );
    const h = await makeHarness({ protocol: 'ocpp1.6', sql });
    h.sim.setConfigValue('SupportedFeatureProfiles', 'Core,Reservation');
    const res = await h.invoke('ReserveNow', {
      reservationId: 4,
      connectorId: 1,
      idTag: 'TAG',
      expiryDate: inOneHour(),
    });
    expect(res).toEqual({ status: 'Occupied' });
  });
});

describe('CancelReservation', () => {
  it('2.1: unknown reservation is rejected with UnknownReservation', async () => {
    const h = await makeHarness();
    expect(await h.invoke('CancelReservation', { reservationId: 99 })).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'UnknownReservation' },
    });
  });

  it('1.6: unknown reservation is rejected without statusInfo', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('CancelReservation', { reservationId: 99 })).toEqual({
      status: 'Rejected',
    });
  });

  it('2.1: cancels, frees the EVSE, reports Removed and stops the expiry timer', async () => {
    const h = await makeHarness();
    await h.invoke('ReserveNow', {
      id: 3,
      evseId: 1,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 10_000).toISOString(),
    });
    const res = await h.invoke('CancelReservation', { reservationId: 3 });
    expect(res).toEqual({ status: 'Accepted' });
    expect(reservations(h).has(3)).toBe(false);
    expect(statusOf(h, 1)).toBe('Available');
    await vi.advanceTimersByTimeAsync(20_000);
    const updates = h.sent('ReservationStatusUpdate');
    expect(updates).toEqual([{ reservationId: 3, reservationUpdateStatus: 'Removed' }]);
  });
});

describe('ChangeAvailability cancels reservations', () => {
  it('2.1: Inoperative removes the reservations of the affected EVSE', async () => {
    const h = await makeHarness();
    await h.invoke('ReserveNow', {
      id: 8,
      evseId: 1,
      idToken: { idToken: 'A', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    const res = await h.invoke('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: 1 },
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(reservations(h).size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('ReservationStatusUpdate')).toContainEqual({
      reservationId: 8,
      reservationUpdateStatus: 'Removed',
    });
  });
});

function TWO_EVSES_OPTS(): HarnessOptions {
  return { config: TWO_EVSES };
}
