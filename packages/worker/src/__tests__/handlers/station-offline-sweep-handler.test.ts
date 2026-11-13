// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cron entry of the offline sweep: the data plan thresholds, one Redis
// registry client for every run, and the summary log only when it marked any.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  mark: vi.fn(),
  getDataPlanValues: vi.fn(),
  createRedisClient: vi.fn(() => ({ redis: true })),
  getInstanceId: vi.fn(),
  cancelHolds: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: vi.fn().mockResolvedValue([{ id: 'r1', reservation_id: 5, driver_id: 'drv' }]),
  findStaleOnlineStations: h.find,
  markStationOfflineIfStale: h.mark,
  getDataPlanValues: h.getDataPlanValues,
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRedisClient: h.createRedisClient,
  RedisConnectionRegistry: vi.fn(function (this: Record<string, unknown>) {
    this['getInstanceId'] = h.getInstanceId;
  }),
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('@evtivity/services/reservation-expiry', () => ({
  cancelHoldsForStationOutage: h.cancelHolds,
}));
vi.mock('@evtivity/services/reservation-notify', () => ({ notifyReservationDriver: h.notify }));
vi.mock('../../lib/payments.js', () => ({ paymentContext: vi.fn(() => ({})) }));

const { stationOfflineSweepHandler } = await import('../../handlers/station-offline-sweep.js');

function makeLog(): Logger & { info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  h.find.mockReset();
  h.mark.mockReset();
  h.getDataPlanValues.mockImplementation((plan: string) =>
    Promise.resolve({ heartbeatInterval: plan === 'cellular' ? 3600 : 900 }),
  );
  h.getInstanceId.mockResolvedValue(null);
  h.cancelHolds.mockResolvedValue(0);
  h.notify.mockResolvedValue(undefined);
});

describe('stationOfflineSweepHandler', () => {
  it('reads the heartbeat of each data plan, reuses one Redis client and logs only a run that marked any', async () => {
    h.find.mockResolvedValue([]);
    const quiet = makeLog();
    await stationOfflineSweepHandler(quiet);
    expect(h.getDataPlanValues).toHaveBeenCalledWith('wifi_or_wired');
    expect(h.getDataPlanValues).toHaveBeenCalledWith('cellular');
    expect(quiet.info).not.toHaveBeenCalled();

    const now = new Date();
    h.find.mockResolvedValue([
      {
        id: 'uuid-1',
        stationId: 'CS-1',
        lastActivityAt: new Date(now.getTime() - 3_600_000),
        staleBefore: now,
        dataPlan: 'wifi_or_wired',
        thresholdMs: 1000,
      },
    ]);
    h.mark.mockResolvedValue({ siteId: null });
    const loud = makeLog();
    await stationOfflineSweepHandler(loud);
    expect(loud.info).toHaveBeenCalledWith(
      expect.objectContaining({ markedOffline: 1 }),
      'Offline sweep marked stations offline',
    );
    expect(h.cancelHolds).toHaveBeenCalledWith(
      expect.objectContaining({ logger: loud }),
      expect.objectContaining({ stationOcppId: 'CS-1', cause: 'offline' }),
    );
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.StationFaulted',
      expect.objectContaining({ reservationDbId: 'r1', driverId: 'drv' }),
      {},
      expect.objectContaining({ logger: loud }),
    );
    expect(h.createRedisClient).toHaveBeenCalledTimes(1);
  });
});
