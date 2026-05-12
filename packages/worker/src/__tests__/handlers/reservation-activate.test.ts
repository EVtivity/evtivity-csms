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
  const methods = ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'set', 'returning', 'limit'];
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
  evses: {},
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
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
});
