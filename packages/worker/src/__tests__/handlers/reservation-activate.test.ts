// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

// Drizzle chain mock: each call returns the chain itself; awaiting it pulls
// the next preset result off the queue. `setupDbResults(...arrays)` queues
// results for the SELECT/UPDATE chains in call order.
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'innerJoin',
    'leftJoin',
    'set',
    'returning',
    'limit',
    'orderBy',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

const mockWriteAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/database', () => ({
  client: {},
  db: {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  reservations: {
    id: 'reservations.id',
    status: 'reservations.status',
    driverId: 'reservations.driverId',
  },
  chargingStations: {},
  chargingSessions: {
    id: 'chargingSessions.id',
    stationId: 'chargingSessions.stationId',
    driverId: 'chargingSessions.driverId',
    evseId: 'chargingSessions.evseId',
    endedAt: 'chargingSessions.endedAt',
    startedAt: 'chargingSessions.startedAt',
  },
  connectors: { status: 'connectors.status', evseId: 'connectors.evseId' },
  evses: { id: 'evses.id', stationId: 'evses.stationId', evseId: 'evses.evseId' },
  writeReservationAudit: (...args: unknown[]) => mockWriteAudit(...args),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  getReservationSettings: vi.fn().mockResolvedValue({
    enabled: true,
    bufferMinutes: 0,
    cancellationWindowMinutes: 0,
    cancellationFeeCents: 0,
    maxHours: 0,
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));

const mockDispatchDriver = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: (...args: unknown[]) => mockDispatchDriver(...args),
  };
});

const mockPublish = vi.fn().mockResolvedValue(undefined);
const pubsub: PubSubClient = {
  publish: mockPublish,
  subscribe: vi.fn(),
} as unknown as PubSubClient;

function makeJob(reservationDbId: string): Job {
  return { data: { reservationDbId } } as unknown as Job;
}

describe('handleReservationActivate', () => {
  beforeEach(() => {
    setupDbResults();
    mockDispatchDriver.mockClear();
    mockPublish.mockClear();
    mockWriteAudit.mockClear();
  });

  it('cancels reservation with metadata and notifies driver when station is offline', async () => {
    setupDbResults(
      // SELECT reservation row: scheduled, station offline, driver attached
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: false,
          ocppProtocol: 'ocpp2.1',
          evseDbId: null,
        },
      ],
      // UPDATE+RETURNING for the conditional cancel (returns the driver_id)
      [{ driverId: 'drv_1' }],
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
    expect(mockDispatchDriver).toHaveBeenCalledWith(
      expect.anything(),
      'reservation.Cancelled',
      'drv_1',
      expect.objectContaining({
        reservationId: 42,
        stationId: 'CS-001',
        cancellationFeeFormatted: '',
      }),
      expect.anything(),
      pubsub,
    );
    // No ReserveNow published when the station was offline
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not notify when offline-station UPDATE finds no scheduled row to cancel', async () => {
    // The status guard prevents a double-cancel: the UPDATE returns an empty
    // array when another worker (or operator/driver cancel) already flipped
    // the row out of `scheduled`. The handler must NOT dispatch in that case.
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: false,
          ocppProtocol: 'ocpp2.1',
          evseDbId: null,
        },
      ],
      // UPDATE+RETURNING returns no rows (lost race with a concurrent cancel)
      [],
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockDispatchDriver).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not notify when offline cancel matches but reservation has no driver', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: null,
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: false,
          ocppProtocol: 'ocpp2.1',
          evseDbId: null,
        },
      ],
      // UPDATE returns the row but with no driver_id
      [{ driverId: null }],
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });

  it('does not throw when driver-notification dispatch fails', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: false,
          ocppProtocol: 'ocpp2.1',
          evseDbId: null,
        },
      ],
      [{ driverId: 'drv_1' }],
    );
    mockDispatchDriver.mockRejectedValueOnce(new Error('SMTP down'));

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await expect(handleReservationActivate(makeJob('rsv_1'), pubsub)).resolves.toBeUndefined();
  });

  it('skips activation when the reservation row is not found', async () => {
    setupDbResults([]); // SELECT reservation -> no row

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('missing'), pubsub);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockDispatchDriver).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('skips activation when the reservation is no longer scheduled', async () => {
    setupDbResults([
      {
        id: 'rsv_1',
        reservationId: 42,
        status: 'active',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        driverId: 'drv_1',
        stationDbId: 'sta_1',
        stationOcppId: 'CS-001',
        isOnline: true,
        evseDbId: null,
      },
    ]);

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('marks the reservation expired and audits when it lapsed before activation', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() - 60 * 1000), // already expired
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: null,
        },
      ],
      [{ id: 'rsv_1' }], // UPDATE -> expired, one row affected
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'expired',
        actor: 'system',
        statusBefore: 'scheduled',
        statusAfter: 'expired',
        notes: 'expired before scheduled activation',
      }),
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not audit expiry when the guarded expire-update matches no row', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() - 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: null,
        },
      ],
      [], // UPDATE expired -> no rows (lost race)
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('activates the reservation and publishes ReserveNow when the connector is available', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt,
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'available' }], // connector re-validation: available
      [{ evseId: 3 }], // EVSE OCPP id lookup
      [{ id: 'rsv_1' }], // guarded UPDATE scheduled->active
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    // Status flipped to active and audited exactly once.
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'updated',
        statusBefore: 'scheduled',
        statusAfter: 'active',
        notes: 'scheduled activation',
      }),
    );
    // ReserveNow published on the ocpp_commands channel with the 2.1 payload.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockPublish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    const msg = JSON.parse(raw);
    expect(msg).toMatchObject({
      stationId: 'CS-001',
      action: 'ReserveNow',
      payload: {
        id: 42,
        expiryDateTime: expiresAt.toISOString(),
        evseId: 3,
        idToken: { idToken: 'drv_1', type: 'Central' },
      },
    });
    // version intentionally omitted so CommandListener performs translation.
    expect(msg.payload.version).toBeUndefined();
    expect(typeof msg.commandId).toBe('string');
    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });

  it('activates a reservation with no EVSE assigned (operator idToken, no evseId)', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 7,
          status: 'scheduled',
          expiresAt,
          driverId: null,
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: null,
        },
      ],
      [], // connector re-validation: no connector rows -> skip availability cancel
      [{ id: 'rsv_1' }], // guarded UPDATE scheduled->active
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, raw] = mockPublish.mock.calls[0] as [string, string];
    const msg = JSON.parse(raw);
    expect(msg.payload.evseId).toBeUndefined();
    expect(msg.payload.idToken).toEqual({ idToken: 'operator', type: 'Central' });
  });

  it('does not publish ReserveNow when the guarded activate-update matches no row', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: null,
        },
      ],
      [{ status: 'available' }], // connector available
      [], // guarded UPDATE -> no rows (already activated by a concurrent run)
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('cancels with evse_in_use reason and notifies when the connector is occupied', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'occupied' }], // connector busy (not faulted/unavailable)
      [], // same-driver active-session lookup -> none
      [{ driverId: 'drv_1' }], // UPDATE cancelled -> returns driver
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelled',
        statusAfter: 'cancelled',
        notes: 'evse_in_use_at_activation',
      }),
    );
    expect(mockDispatchDriver).toHaveBeenCalledWith(
      expect.anything(),
      'reservation.Cancelled',
      'drv_1',
      expect.objectContaining({ reservationId: 42, stationId: 'CS-001' }),
      expect.anything(),
      pubsub,
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('cancels with station_faulted reason when every connector is faulted/unavailable', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'faulted' }, { status: 'unavailable' }], // all non-operational
      [], // same-driver active-session lookup -> none
      [{ driverId: 'drv_1' }], // UPDATE cancelled
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelled',
        notes: 'station_faulted_at_activation',
      }),
    );
    expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the availability cancel matches no row', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'occupied' }],
      [], // same-driver session lookup -> none
      [], // UPDATE cancelled -> no rows
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });

  it('transitions to in_use without ReserveNow when the same driver is already charging', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'occupied' }], // connector busy
      [{ id: 'ses_1' }], // same-driver active session present
      [{ id: 'rsv_1' }], // UPDATE scheduled->in_use
      [], // UPDATE chargingSessions link
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'used',
        statusBefore: 'scheduled',
        statusAfter: 'in_use',
        notes: expect.stringContaining('ses_1'),
      }),
    );
    // Fulfilled in person: no ReserveNow and no cancellation notification.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });

  it('does not link the session or audit when the in_use flip matches no row', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'occupied' }],
      [{ id: 'ses_1' }], // same-driver session present
      [], // UPDATE scheduled->in_use matches no row (lost race)
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('checks for a same-driver session without an evse filter when no EVSE is reserved', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: null, // station-wide reservation, no specific EVSE
        },
      ],
      [{ status: 'occupied' }], // some connector busy
      [], // same-driver session lookup (no evse filter) -> none
      [{ driverId: 'drv_1' }], // UPDATE cancelled
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancelled', notes: 'evse_in_use_at_activation' }),
    );
    expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
  });

  it('omits evseId from ReserveNow when the assigned EVSE row cannot be resolved', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: 'drv_1',
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_gone',
        },
      ],
      [{ status: 'available' }], // connector available
      [], // EVSE OCPP id lookup -> no row, evseOcppId stays undefined
      [{ id: 'rsv_1' }], // guarded UPDATE scheduled->active
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, raw] = mockPublish.mock.calls[0] as [string, string];
    const msg = JSON.parse(raw);
    expect(msg.action).toBe('ReserveNow');
    expect(msg.payload.evseId).toBeUndefined();
  });

  it('still cancels when connector is busy and the reservation has no driver', async () => {
    setupDbResults(
      [
        {
          id: 'rsv_1',
          reservationId: 42,
          status: 'scheduled',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          driverId: null, // no driver -> skip same-driver session lookup
          stationDbId: 'sta_1',
          stationOcppId: 'CS-001',
          isOnline: true,
          evseDbId: 'evse_1',
        },
      ],
      [{ status: 'occupied' }],
      [{ driverId: null }], // UPDATE cancelled -> returns null driver
    );

    const { handleReservationActivate } = await import('../../handlers/reservation-activate.js');
    await handleReservationActivate(makeJob('rsv_1'), pubsub);

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancelled', notes: 'evse_in_use_at_activation' }),
    );
    // No driver to notify.
    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });
});
