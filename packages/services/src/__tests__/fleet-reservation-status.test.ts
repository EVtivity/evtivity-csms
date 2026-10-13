// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));

vi.mock('@evtivity/database', () => ({
  db: { transaction: transactionMock },
  fleetReservations: { id: 'fr.id', status: 'fr.status' },
  reservations: { status: 'r.status', fleetReservationId: 'r.fleet_reservation_id' },
}));

import {
  deriveFleetReservationStatus,
  initialFleetReservationStatus,
  isTerminalFleetReservationStatus,
  refreshFleetReservationStatuses,
  syncFleetReservationStatus,
} from '../fleet-reservation-status.js';

/** A transaction whose first select returns the booking and second the slots. */
function fakeTx(booking: { status: string } | undefined, slots: string[]) {
  const updateWhere = vi.fn(() => Promise.resolve(undefined));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  let selectCall = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        selectCall += 1;
        if (selectCall === 1) {
          return { for: () => Promise.resolve(booking == null ? [] : [booking]) };
        }
        return Promise.resolve(slots.map((status) => ({ status })));
      },
    }),
  }));
  transactionMock.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select, update }),
  );
  return { update, updateSet };
}

beforeEach(() => {
  transactionMock.mockReset();
});

describe('deriveFleetReservationStatus', () => {
  it.each([
    [['scheduled', 'scheduled'], 'scheduled'],
    [['active', 'scheduled'], 'active'],
    [['in_use', 'used'], 'active'],
    [['active', 'cancelled'], 'partial'],
    [['scheduled', 'expired'], 'partial'],
    [['in_use', 'cancelled'], 'partial'],
    [['used', 'cancelled'], 'completed'],
    [['used', 'expired'], 'completed'],
    [['expired', 'cancelled'], 'expired'],
    [['cancelled'], 'cancelled'],
    [[], 'cancelled'],
  ])('%j -> %s', (slots, expected) => {
    expect(deriveFleetReservationStatus(slots)).toBe(expected);
  });
});

describe('initialFleetReservationStatus', () => {
  it('is scheduled for a future start and active otherwise', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    expect(initialFleetReservationStatus(new Date('2026-10-13T11:00:00Z'), now)).toBe('scheduled');
    expect(initialFleetReservationStatus(new Date('2026-10-13T09:00:00Z'), now)).toBe('active');
    expect(initialFleetReservationStatus(null, now)).toBe('active');
  });
});

describe('isTerminalFleetReservationStatus', () => {
  it('treats completed, expired and cancelled as final', () => {
    expect(['completed', 'expired', 'cancelled'].every(isTerminalFleetReservationStatus)).toBe(
      true,
    );
    expect(['scheduled', 'active', 'partial'].some(isTerminalFleetReservationStatus)).toBe(false);
  });
});

describe('syncFleetReservationStatus', () => {
  it('writes the derived status when it changed', async () => {
    const { update, updateSet } = fakeTx({ status: 'active' }, ['cancelled']);
    await expect(syncFleetReservationStatus('fr-1')).resolves.toBe('cancelled');
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('writes nothing when the status is unchanged', async () => {
    const { update } = fakeTx({ status: 'scheduled' }, ['scheduled']);
    await expect(syncFleetReservationStatus('fr-1')).resolves.toBe('scheduled');
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a final status (P5)', async () => {
    const { update } = fakeTx({ status: 'cancelled' }, ['used']);
    await expect(syncFleetReservationStatus('fr-1')).resolves.toBe('cancelled');
    expect(update).not.toHaveBeenCalled();
  });

  it('returns null for a missing booking', async () => {
    const { update } = fakeTx(undefined, []);
    await expect(syncFleetReservationStatus('fr-x')).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('refreshFleetReservationStatuses', () => {
  it('skips non-fleet slots and refreshes each booking once', async () => {
    fakeTx({ status: 'active' }, ['active']);
    await refreshFleetReservationStatuses(['fr-1', null, undefined, 'fr-1']);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('fails open with a warning (P9)', async () => {
    transactionMock.mockRejectedValue(new Error('connection lost'));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(refreshFleetReservationStatuses(['fr-1'], logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fleetReservationId: 'fr-1' }),
      'Fleet reservation status refresh failed',
    );
  });
});
