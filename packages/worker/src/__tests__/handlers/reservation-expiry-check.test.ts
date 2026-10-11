// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Raw client mock: each tagged-template call records its SQL text and
// resolves with the next queued result.
const { queries, results, mockClient } = vi.hoisted(() => {
  const queries: string[] = [];
  const results: unknown[][] = [];
  const mockClient = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join('?'));
    return Promise.resolve(results.shift() ?? []);
  });
  return { queries, results, mockClient };
});

vi.mock('@evtivity/database', () => ({ client: mockClient }));

const { mockPubSub } = vi.hoisted(() => ({
  mockPubSub: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() },
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => mockPubSub }));

const { paymentCtx } = vi.hoisted(() => ({ paymentCtx: { registry: {}, logger: {} } }));
vi.mock('../../lib/payments.js', () => ({ paymentContext: vi.fn(() => paymentCtx) }));

const calls: string[] = [];
const mockExpire = vi.fn(async (..._args: unknown[]) => {
  calls.push('expire');
  return [] as unknown[];
});
const mockSettle = vi.fn(async (..._args: unknown[]) => {
  calls.push('settle');
  return 0;
});
vi.mock('@evtivity/services/reservation-expiry', () => ({
  expireDueReservations: (...args: unknown[]) => mockExpire(...args),
  settleDueNoShowFees: (...args: unknown[]) => mockSettle(...args),
}));
const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: (...args: unknown[]) => mockNotify(...args),
}));
const mockEnqueue = vi.fn(async (..._args: unknown[]) => {
  calls.push('activate');
});
vi.mock('../../reservation-worker.js', () => ({
  enqueueOverdueReservationActivation: (...args: unknown[]) => mockEnqueue(...args),
}));

import {
  OVERDUE_ACTIVATION_LIMIT,
  reservationExpiryCheckHandler,
} from '../../handlers/reservation-expiry-check.js';

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

// The handler's raw queries in order: overdue scheduled rows, then expiring rows.
function queue(overdue: unknown[], expiring: unknown[]): void {
  results.push(overdue, expiring);
}

beforeEach(() => {
  queries.length = 0;
  results.length = 0;
  calls.length = 0;
  mockClient.mockClear();
  mockExpire.mockClear();
  mockSettle.mockClear();
  mockNotify.mockClear();
  mockEnqueue.mockClear();
});

describe('reservationExpiryCheckHandler', () => {
  it('expires through the shared expiry with the worker pub/sub, payment context and logger', async () => {
    queue([], []);
    const log = makeLog();
    await reservationExpiryCheckHandler(log);

    expect(mockExpire).toHaveBeenCalledWith({
      pubsub: mockPubSub,
      payments: paymentCtx,
      logger: log,
    });
  });

  it('logs how many reservations expired', async () => {
    queue([], []);
    mockExpire.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    const log = makeLog();
    await reservationExpiryCheckHandler(log);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Expired reservations');
  });

  it('TC-RES-14: settles the due no-show fees each run, after the expiry', async () => {
    queue([], []);
    const log = makeLog();
    await reservationExpiryCheckHandler(log);

    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledWith({
      pubsub: mockPubSub,
      payments: paymentCtx,
      logger: log,
    });
    expect(calls.indexOf('expire')).toBeLessThan(calls.indexOf('settle'));
  });

  describe('overdue activation (G6)', () => {
    it('TC-RES-08: adds the activation job of each scheduled row whose start passed', async () => {
      queue([{ id: 'rsv_a' }, { id: 'rsv_b' }], []);
      await reservationExpiryCheckHandler(makeLog());

      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenNthCalledWith(1, 'rsv_a');
      expect(mockEnqueue).toHaveBeenNthCalledWith(2, 'rsv_b');
      const sql = queries[0]!;
      expect(sql).toContain("status = 'scheduled'");
      expect(sql).toContain('starts_at <= now()');
      expect(sql).toContain('expires_at > now()');
      expect(mockClient.mock.calls[0]).toContain(OVERDUE_ACTIVATION_LIMIT);
      // Expired rows go first, so a lapsed row is expired, never activated.
      expect(calls.indexOf('expire')).toBeLessThan(calls.indexOf('activate'));
    });

    it('TC-RES-08: adds nothing when no scheduled row is overdue (a second run after activation)', async () => {
      queue([], []);
      await reservationExpiryCheckHandler(makeLog());
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('TC-RES-08: keeps going when one job cannot be added (fail-open)', async () => {
      queue([{ id: 'rsv_a' }, { id: 'rsv_b' }], []);
      mockEnqueue.mockRejectedValueOnce(new Error('redis down'));
      const log = makeLog();
      await reservationExpiryCheckHandler(log);

      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    });
  });

  describe('Expiring warning', () => {
    it('TC-RES-23: dedups the warning per reservation on metadata.reservationId, not per driver', async () => {
      queue([], []);
      await reservationExpiryCheckHandler(makeLog());

      const sql = queries[1]!;
      expect(sql).toContain("n.event_type = 'reservation.Expiring'");
      expect(sql).toContain("n.metadata->>'reservationId' = r.id");
      expect(sql).not.toContain("'driverId'");
      expect(sql).toContain("r.status = 'active'");
      expect(sql).toContain('r.driver_id IS NOT NULL');
    });

    it('TC-RES-23: sends reservation.Expiring with the OCPP id, station and expiresAt', async () => {
      queue(
        [],
        [
          {
            id: 'rsv_1',
            driver_id: 'drv_1',
            reservation_ocpp_id: 42,
            station_ocpp_id: 'CS-001',
            expires_at: '2026-10-11 12:00:00+00',
          },
        ],
      );
      await reservationExpiryCheckHandler(makeLog());

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Expiring',
        {
          reservationDbId: 'rsv_1',
          reservationOcppId: 42,
          stationOcppId: 'CS-001',
          driverId: 'drv_1',
          expiresAt: '2026-10-11 12:00:00+00',
        },
        {},
        expect.objectContaining({ pubsub: mockPubSub }),
      );
    });

    it('sends no warning when nothing is expiring', async () => {
      queue([], []);
      await reservationExpiryCheckHandler(makeLog());
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });
});
