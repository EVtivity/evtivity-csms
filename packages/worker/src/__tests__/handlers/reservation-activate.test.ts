// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
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
const setCalls: Array<Record<string, unknown>> = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'innerJoin',
    'leftJoin',
    'returning',
    'limit',
    'orderBy',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain['set'] = vi.fn((values: Record<string, unknown>) => {
    setCalls.push(values);
    return chain;
  });
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
const mockAlertStationWatchers = vi.fn(async (..._args: unknown[]) => false);
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
    stationAckAt: 'reservations.stationAckAt',
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
  alertStationWatchersIfAvailable: (...args: unknown[]) => mockAlertStationWatchers(...args),
}));

// Each guard condition records its column, so a test can check the revert guard.
const isNullCalls: unknown[] = [];
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn((col: unknown) => {
    isNullCalls.push(col);
  }),
}));

const mockApplyCancel = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) => mockApplyCancel(...args),
}));
const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: (...args: unknown[]) => mockNotify(...args),
}));
const mockReserveNowPayload = vi.fn();
vi.mock('@evtivity/services/reservation.service', () => ({
  reserveNowPayload: (...args: unknown[]) => mockReserveNowPayload(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
const pubsub: PubSubClient = {
  publish: mockPublish,
  subscribe: vi.fn(),
} as unknown as PubSubClient;

function makeJob(reservationDbId: string): Job {
  return { data: { reservationDbId } } as unknown as Job;
}

function reserveNowCalls(): Array<[string, string]> {
  return mockPublish.mock.calls.filter(([ch]) => ch === 'ocpp_commands') as Array<[string, string]>;
}

const createdAt = new Date('2026-10-11T08:00:00Z');
const startsAt = new Date('2026-10-11T10:00:00Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rsv_1',
    reservationId: 42,
    status: 'scheduled',
    startsAt,
    createdAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    driverId: 'drv_1',
    tokenId: 'tok_1',
    stationDbId: 'sta_1',
    stationOcppId: 'CS-001',
    siteId: 'site_1',
    isOnline: true,
    evseDbId: 'evse_1',
    ...overrides,
  };
}

// The handler is imported after the mocks above are initialized. The first import loads the
// whole handler graph, which can take longer than one test's 5 s timeout on a busy machine,
// so it happens once here with its own timeout instead of inside the first test.
let handleReservationActivate: typeof import('../../handlers/reservation-activate.js').handleReservationActivate;
beforeAll(async () => {
  ({ handleReservationActivate } = await import('../../handlers/reservation-activate.js'));
}, 30_000);

describe('handleReservationActivate', () => {
  beforeEach(() => {
    setupDbResults();
    setCalls.length = 0;
    isNullCalls.length = 0;
    mockPublish.mockReset().mockResolvedValue(undefined);
    mockWriteAudit.mockClear();
    mockNotify.mockClear();
    mockAlertStationWatchers.mockClear();
    mockApplyCancel.mockReset().mockResolvedValue({
      cancelled: true,
      statusBefore: 'scheduled',
      feeChargedCents: 0,
      feeChargeFailed: false,
      feeCurrency: null,
    });
    mockReserveNowPayload
      .mockReset()
      .mockImplementation((r: { reservationId: number; expiresAt: Date; tokenId: string | null }) =>
        Promise.resolve({
          id: r.reservationId,
          expiryDateTime: r.expiresAt.toISOString(),
          idToken: { idToken: r.tokenId === 'tok_1' ? 'RFID-0001' : 'drv_1', type: 'ISO14443' },
          evseId: 3,
        }),
      );
  });

  describe('activation-time cancels (shared cancel, station_rejected audit)', () => {
    it('cancels as system when the station is offline and notifies the driver', async () => {
      setupDbResults([row({ isOnline: false })]);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: 'rsv_1',
          siteId: 'site_1',
          driverId: 'drv_1',
          startsAt,
          createdAt,
          actor: 'system',
          reason: 'station_offline_at_activation',
          auditAction: 'station_rejected',
          chargeFee: false,
          pubsub,
        }),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        expect.objectContaining({
          reservationDbId: 'rsv_1',
          reservationOcppId: 42,
          stationOcppId: 'CS-001',
          driverId: 'drv_1',
        }),
        { cancellationFeeFormatted: '' },
        expect.objectContaining({ pubsub }),
      );
      expect(reserveNowCalls()).toHaveLength(0);
      // The shared cancel writes the audit row; the handler writes none.
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    it('does not notify when the shared cancel loses the race', async () => {
      setupDbResults([row({ isOnline: false })]);
      mockApplyCancel.mockResolvedValue({ cancelled: false, statusBefore: null });

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('uses created_at as the start of a reservation without starts_at', async () => {
      setupDbResults([row({ isOnline: false, startsAt: null })]);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ startsAt: createdAt }),
      );
    });

    it('cancels with evse_in_use_at_activation when the connector is occupied', async () => {
      setupDbResults(
        [row()],
        [{ status: 'occupied' }], // connector busy
        [], // same-driver session lookup -> none
      );

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'evse_in_use_at_activation',
          auditAction: 'station_rejected',
          actor: 'system',
        }),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(reserveNowCalls()).toHaveLength(0);
    });

    it('cancels with station_faulted_at_activation when every connector is faulted or unavailable', async () => {
      setupDbResults([row()], [{ status: 'faulted' }, { status: 'unavailable' }], []);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'station_faulted_at_activation',
          auditAction: 'station_rejected',
        }),
      );
    });

    it('still cancels a busy station-wide hold without a driver (no session lookup)', async () => {
      setupDbResults(
        [row({ driverId: null, tokenId: null, evseDbId: null })],
        [{ status: 'occupied' }],
      );

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'evse_in_use_at_activation', driverId: null }),
      );
    });
  });

  describe('expired before activation', () => {
    it('marks the reservation expired and audits when it lapsed before activation', async () => {
      setupDbResults([row({ expiresAt: new Date(Date.now() - 60 * 1000) })], [{ id: 'rsv_1' }]);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockWriteAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: 'rsv_1',
          action: 'expired',
          statusBefore: 'scheduled',
          statusAfter: 'expired',
          notes: 'expired before scheduled activation',
        }),
      );
      expect(reserveNowCalls()).toHaveLength(0);
      expect(mockAlertStationWatchers).toHaveBeenCalledWith(expect.anything(), 'sta_1');
    });

    it('does not audit expiry when the guarded expire-update matches no row', async () => {
      setupDbResults([row({ expiresAt: new Date(Date.now() - 60 * 1000) })], []);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockWriteAudit).not.toHaveBeenCalled();
    });
  });

  describe('skips', () => {
    it('skips activation when the reservation row is not found', async () => {
      setupDbResults([]);
      await handleReservationActivate(makeJob('rsv_x'), pubsub);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('skips activation when the reservation is no longer scheduled', async () => {
      setupDbResults([row({ status: 'cancelled' })]);
      await handleReservationActivate(makeJob('rsv_1'), pubsub);
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    it('does not publish ReserveNow when the guarded activate-update matches no row', async () => {
      setupDbResults([row()], [{ status: 'available' }], []);
      await handleReservationActivate(makeJob('rsv_1'), pubsub);
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });
  });

  describe('same-driver session at activation', () => {
    it('transitions to in_use without ReserveNow when the same driver is already charging', async () => {
      setupDbResults(
        [row()],
        [{ status: 'occupied' }],
        [{ id: 'ses_1' }], // same-driver active session present
        [{ id: 'rsv_1' }], // UPDATE scheduled->in_use
        [], // UPDATE chargingSessions link
      );

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockWriteAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'used',
          statusBefore: 'scheduled',
          statusAfter: 'in_use',
          notes: expect.stringContaining('ses_1'),
        }),
      );
      expect(reserveNowCalls()).toHaveLength(0);
      expect(mockApplyCancel).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does not link the session or audit when the in_use flip matches no row', async () => {
      setupDbResults([row()], [{ status: 'occupied' }], [{ id: 'ses_1' }], []);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockWriteAudit).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('ReserveNow', () => {
    it('TC-RES-02: sends ReserveNow built from the bound token (reserveNowPayload), no version', async () => {
      const r = row();
      setupDbResults([r], [{ status: 'available' }], [{ id: 'rsv_1' }]);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockReserveNowPayload).toHaveBeenCalledWith({
        reservationId: 42,
        expiresAt: r.expiresAt,
        evseId: 'evse_1',
        tokenId: 'tok_1',
        driverId: 'drv_1',
      });
      const calls = reserveNowCalls();
      expect(calls).toHaveLength(1);
      const msg = JSON.parse(calls[0]![1]);
      expect(msg).toMatchObject({
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: {
          id: 42,
          evseId: 3,
          idToken: { idToken: 'RFID-0001', type: 'ISO14443' },
        },
      });
      // No version, so the command listener translates for an OCPP 1.6 station.
      expect(msg.version).toBeUndefined();
      expect(msg.payload.version).toBeUndefined();
    });

    it('TC-RES-22: audits the scheduled->active flip as activated', async () => {
      setupDbResults([row()], [{ status: 'available' }], [{ id: 'rsv_1' }]);

      await handleReservationActivate(makeJob('rsv_1'), pubsub);

      expect(mockWriteAudit).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: 'rsv_1',
          action: 'activated',
          actor: 'system',
          statusBefore: 'scheduled',
          statusAfter: 'active',
        }),
      );
      expect(mockPublish).toHaveBeenCalledWith('csms_events', expect.any(String));
    });

    it('TC-RES-06: a publish failure reverts the row to scheduled (guarded) and rethrows', async () => {
      setupDbResults(
        [row()],
        [{ status: 'available' }],
        [{ id: 'rsv_1' }], // flip to active
        [{ id: 'rsv_1' }], // guarded revert
      );
      mockPublish.mockImplementation((channel: string) =>
        channel === 'ocpp_commands'
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve(undefined),
      );

      await expect(handleReservationActivate(makeJob('rsv_1'), pubsub)).rejects.toThrow(
        'redis down',
      );

      // Flip to active, then back to scheduled.
      expect(setCalls.map((s) => s['status'])).toEqual(['active', 'scheduled']);
      // The revert is guarded on a hold the station has not accepted.
      expect(isNullCalls).toContain('reservations.stationAckAt');
      expect(mockWriteAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusBefore: 'active', statusAfter: 'scheduled' }),
        undefined,
        expect.anything(),
      );
      // No reservation.changed SSE for an activation that did not happen.
      expect(mockPublish.mock.calls.filter(([ch]) => ch === 'csms_events')).toHaveLength(0);
    });

    it('TC-RES-06: the retry after a reverted activation sends ReserveNow once', async () => {
      // First attempt: publish fails, row reverted.
      setupDbResults([row()], [{ status: 'available' }], [{ id: 'rsv_1' }], [{ id: 'rsv_1' }]);
      mockPublish.mockImplementationOnce(() => Promise.reject(new Error('redis down')));
      await expect(handleReservationActivate(makeJob('rsv_1'), pubsub)).rejects.toThrow();
      expect(reserveNowCalls()).toHaveLength(1); // attempted, rejected

      // BullMQ retry: the row is scheduled again, the publish succeeds.
      mockPublish.mockReset().mockResolvedValue(undefined);
      setupDbResults([row()], [{ status: 'available' }], [{ id: 'rsv_1' }]);
      await handleReservationActivate(makeJob('rsv_1'), pubsub);
      expect(reserveNowCalls()).toHaveLength(1);

      // A third run (duplicate job) sees the row active and sends nothing.
      mockPublish.mockClear();
      setupDbResults([row({ status: 'active' })]);
      await handleReservationActivate(makeJob('rsv_1'), pubsub);
      expect(reserveNowCalls()).toHaveLength(0);
    });

    it('TC-RES-06: a revert that loses its guard (station accepted, or cancelled) writes no audit and still rethrows', async () => {
      setupDbResults([row()], [{ status: 'available' }], [{ id: 'rsv_1' }], []);
      mockPublish.mockImplementation((channel: string) =>
        channel === 'ocpp_commands' ? Promise.reject(new Error('boom')) : Promise.resolve(),
      );

      await expect(handleReservationActivate(makeJob('rsv_1'), pubsub)).rejects.toThrow('boom');

      // Only the activated audit.
      expect(mockWriteAudit).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'activated' }));
    });
  });
});
