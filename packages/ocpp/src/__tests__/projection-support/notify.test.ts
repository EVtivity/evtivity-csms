// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { EventBus, Logger, PubSubClient } from '@evtivity/lib';

const {
  mockIsRoamingEnabled,
  mockGetIdlingGrace,
  mockGetCompanyPriceDisplay,
  mockWriteReservationAudit,
  mockDispatchDriver,
  mockDispatchSystem,
} = vi.hoisted(() => ({
  mockIsRoamingEnabled: vi.fn(),
  mockGetIdlingGrace: vi.fn(),
  mockGetCompanyPriceDisplay: vi.fn(),
  mockWriteReservationAudit: vi.fn(),
  mockDispatchDriver: vi.fn(),
  mockDispatchSystem: vi.fn(),
}));

// Jobs the projections add to the worker queues themselves (station screens,
// maintenance re-assert, station-watch alerts), kept as [job name, JSON data]
// rows in add order.
const queuedJobs = vi.hoisted(() => [] as Array<[string, string]>);
const failNextAdd = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('@evtivity/lib/job-queues', () => ({
  jobQueue: () => ({
    add: (name: string, data: unknown) => {
      const error = failNextAdd.error;
      failNextAdd.error = null;
      if (error != null) return Promise.reject(error);
      queuedJobs.push([name, JSON.stringify(data)]);
      return Promise.resolve();
    },
    addBulk: () => Promise.resolve(),
  }),
}));
function jobsNamed(name: string): Array<[string, string]> {
  return queuedJobs.filter((j) => j[0] === name);
}

const mockResolveOwner = vi.hoisted(() => vi.fn());

vi.mock('@evtivity/database', () => ({
  isRoamingEnabled: mockIsRoamingEnabled,
  resolveOcpiTokenOwner: mockResolveOwner,
  getIdlingGracePeriodMinutes: mockGetIdlingGrace,
  getCompanyPriceDisplay: mockGetCompanyPriceDisplay,
  writeReservationAudit: mockWriteReservationAudit,
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: mockDispatchDriver,
  dispatchSystemNotification: mockDispatchSystem,
  ALL_TEMPLATES_DIRS: ['templates'],
}));

const { createProjectionNotifier, IDLE_NOTICE_MIN_SECONDS } =
  await import('../../server/projection-support/notify.js');

interface Harness {
  query: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  notify: ReturnType<typeof createProjectionNotifier>;
}

function makeHarness(): Harness {
  const query = vi.fn();
  const publish = vi.fn().mockResolvedValue(undefined);
  const track = vi.fn();
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const notify = createProjectionNotifier({
    sql: query as unknown as postgres.Sql,
    eventBus: { track } as unknown as EventBus,
    pubsub: { publish } as unknown as PubSubClient,
    logger: logger as unknown as Logger,
  });
  return { query, publish, track, logger, notify };
}

describe('createProjectionNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuedJobs.length = 0;
    mockIsRoamingEnabled.mockResolvedValue(true);
    mockGetIdlingGrace.mockResolvedValue(10);
    mockGetCompanyPriceDisplay.mockResolvedValue('net');
    mockDispatchDriver.mockResolvedValue(undefined);
    mockDispatchSystem.mockResolvedValue(undefined);
  });

  describe('notifyChange', () => {
    it('publishes the event on csms_events', async () => {
      const h = makeHarness();
      await h.notify.notifyChange('session.started', 'st-1', 'site-1', 'sess-1', { a: 1 });
      expect(h.publish).toHaveBeenCalledWith(
        'csms_events',
        JSON.stringify({
          eventType: 'session.started',
          stationId: 'st-1',
          siteId: 'site-1',
          sessionId: 'sess-1',
          a: 1,
        }),
      );
    });

    it('sends a null session id when none is given', async () => {
      const h = makeHarness();
      await h.notify.notifyChange('station.status', 'st-1', null);
      expect(h.publish).toHaveBeenCalledWith(
        'csms_events',
        JSON.stringify({
          eventType: 'station.status',
          stationId: 'st-1',
          siteId: null,
          sessionId: null,
        }),
      );
    });

    it('logs a publish failure at debug and continues', async () => {
      const h = makeHarness();
      h.publish.mockRejectedValueOnce(new Error('redis down'));
      await expect(h.notify.notifyChange('x', 'st-1', null)).resolves.toBeUndefined();
      expect(h.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'x', stationId: 'st-1' }),
        'SSE notification publish failed; continuing',
      );
    });
  });

  describe('publishStationMessageTransaction', () => {
    const screen = { stationUuid: 'st-uuid', stationId: 'CS-1', protocol: 'ocpp2.1' };

    it('queues the transaction screen render for an OCPP 2.x station', async () => {
      const h = makeHarness();
      await h.notify.publishStationMessageTransaction(screen, 'sess-1', 'updated', 'Charging');
      expect(jobsNamed('station-message-transaction')).toEqual([
        [
          'station-message-transaction',
          JSON.stringify({
            sessionId: 'sess-1',
            internalStationId: 'st-uuid',
            stationOcppId: 'CS-1',
            ocppProtocol: 'ocpp2.1',
            eventType: 'updated',
            chargingState: 'Charging',
          }),
        ],
      ]);
    });

    it('skips OCPP 1.6 and unknown protocols', async () => {
      const h = makeHarness();
      await h.notify.publishStationMessageTransaction(
        { ...screen, protocol: 'ocpp1.6' },
        'sess-1',
        'started',
        null,
      );
      await h.notify.publishStationMessageTransaction(
        { ...screen, protocol: null },
        'sess-1',
        'started',
        null,
      );
      expect(jobsNamed('station-message-transaction')).toEqual([]);
    });

    it('logs a failed job add at debug and continues', async () => {
      const h = makeHarness();
      failNextAdd.error = new Error('redis down');
      await expect(
        h.notify.publishStationMessageTransaction(screen, 'sess-1', 'ended', null),
      ).resolves.toBeUndefined();
      expect(h.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', kind: 'ended' }),
        'Station-message transaction not queued; continuing',
      );
    });
  });

  describe('notifyOcpiPush', () => {
    it('publishes on ocpi_push when roaming is enabled', async () => {
      const h = makeHarness();
      await h.notify.notifyOcpiPush('session', { sessionId: 'sess-1' });
      expect(h.publish).toHaveBeenCalledWith(
        'ocpi_push',
        JSON.stringify({ type: 'session', sessionId: 'sess-1' }),
      );
    });

    it('does not publish when roaming is disabled', async () => {
      const h = makeHarness();
      mockIsRoamingEnabled.mockResolvedValueOnce(false);
      await h.notify.notifyOcpiPush('location', { siteId: 'site-1' });
      expect(h.publish).not.toHaveBeenCalled();
    });

    it('logs a publish failure at debug and continues', async () => {
      const h = makeHarness();
      h.publish.mockRejectedValueOnce(new Error('redis down'));
      await expect(h.notify.notifyOcpiPush('cdr', { cdrId: 'c-1' })).resolves.toBeUndefined();
      expect(h.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cdr' }),
        'OCPI push publish failed; continuing',
      );
    });
  });

  describe('auditLinkedReservationFault', () => {
    it('writes a session_failed audit for a session with a reservation', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([{ reservation_id: 'res-1' }]);
      await h.notify.auditLinkedReservationFault('sess-1', 'faulted: x');
      expect(mockWriteReservationAudit).toHaveBeenCalledWith(
        {
          reservationId: 'res-1',
          action: 'session_failed',
          actor: 'system',
          notes: 'session sess-1: faulted: x',
        },
        undefined,
        h.logger,
      );
    });

    it('does nothing for a session without a reservation', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([{ reservation_id: null }]);
      await h.notify.auditLinkedReservationFault('sess-1', 'faulted: x');
      expect(mockWriteReservationAudit).not.toHaveBeenCalled();
    });

    it('logs a failure at warn and continues', async () => {
      const h = makeHarness();
      h.query.mockRejectedValueOnce(new Error('db down'));
      await expect(h.notify.auditLinkedReservationFault('sess-1', 'r')).resolves.toBeUndefined();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        'Failed to write session_failed reservation audit',
      );
    });
  });

  describe('linkCpoRoamingSession', () => {
    const STATION = [{ station_id: 'CS-1', currency: 'EUR' }];
    const owner = (over: Record<string, unknown> = {}) => ({
      owner: {
        partnerId: 'opr_a',
        authMethod: 'WHITELIST',
        commandId: null,
        authorizationReference: null,
        isValid: true,
        whitelist: 'ALLOWED',
        tokenData: {},
        ...over,
      },
      ambiguous: false,
    });

    function statement(h: ReturnType<typeof makeHarness>, n: number): string {
      return (h.query.mock.calls[n] as [TemplateStringsArray])[0].join('?');
    }

    it('links a whitelisted token to the one partner that owns it', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce(STATION).mockResolvedValueOnce([{ id: 1 }]);
      mockResolveOwner.mockResolvedValueOnce(owner());
      await h.notify.linkCpoRoamingSession('sess-1', 'TOKEN-1');
      expect(mockResolveOwner).toHaveBeenCalledWith(
        { stationOcppId: 'CS-1', tokenUid: 'TOKEN-1', remoteStartId: null },
        expect.anything(),
      );
      expect(h.query).toHaveBeenCalledTimes(2);
      expect(statement(h, 1)).toContain('INSERT INTO ocpi_roaming_sessions');
      expect(statement(h, 1)).toContain('ON CONFLICT (charging_session_id)');
      expect((h.query.mock.calls[1] as unknown[]).slice(1)).toEqual([
        'opr_a',
        'sess-1',
        'sess-1',
        'TOKEN-1',
        'EUR',
        'WHITELIST',
        null,
      ]);
    });

    it('links a START_SESSION start to its partner as COMMAND and uses the command', async () => {
      const h = makeHarness();
      h.query
        .mockResolvedValueOnce(STATION)
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([]);
      mockResolveOwner.mockResolvedValueOnce(
        owner({
          partnerId: 'opr_b',
          authMethod: 'COMMAND',
          commandId: 'cmd-9',
          authorizationReference: 'REF-1',
        }),
      );
      await h.notify.linkCpoRoamingSession('sess-1', 'TOKEN-1', 77);
      expect(mockResolveOwner).toHaveBeenCalledWith(
        expect.objectContaining({ remoteStartId: 77 }),
        expect.anything(),
      );
      expect((h.query.mock.calls[1] as unknown[]).slice(1)).toEqual([
        'opr_b',
        'sess-1',
        'sess-1',
        'TOKEN-1',
        'EUR',
        'COMMAND',
        'REF-1',
      ]);
      expect(statement(h, 2)).toContain('UPDATE ocpi_commands SET charging_session_id');
      expect((h.query.mock.calls[2] as unknown[]).slice(1)).toEqual(['sess-1', 'cmd-9']);
    });

    it('does not link a uid several partners hold, and warns', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce(STATION);
      mockResolveOwner.mockResolvedValueOnce({ owner: null, ambiguous: true });
      await h.notify.linkCpoRoamingSession('sess-1', 'SHARED');
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', idToken: 'SHARED' }),
        'OCPI token uid held by several connected partners; roaming session not linked',
      );
    });

    it('does not link an invalid token or one no partner owns', async () => {
      const h = makeHarness();
      h.query.mockResolvedValue(STATION);
      mockResolveOwner.mockResolvedValueOnce(owner({ isValid: false }));
      await h.notify.linkCpoRoamingSession('sess-1', 'T');
      mockResolveOwner.mockResolvedValueOnce({ owner: null, ambiguous: false });
      await h.notify.linkCpoRoamingSession('sess-1', 'T');
      expect(h.query).toHaveBeenCalledTimes(2);
    });

    it('logs a failure at warn and continues', async () => {
      const h = makeHarness();
      h.query.mockRejectedValueOnce(new Error('db down'));
      await expect(h.notify.linkCpoRoamingSession('sess-1', 'T')).resolves.toBeUndefined();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        'OCPI roaming session link failed; continuing',
      );
    });
  });

  describe('dispatchDueIdlingNotification', () => {
    const idleRow = {
      driver_id: 'drv-1',
      idle_started_at: '2026-01-01T00:00:00Z',
      idle_fee_price_per_minute: '0.10',
      tax_rate: null,
      tax_basis: 'net',
      price_display: null,
      currency: 'USD',
      site_name: 'Main Site',
      guest_email: null,
    };

    it('notifies the driver once the idle period is claimed', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([idleRow]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      // The claim is the only statement: nothing after it can fail a rerun.
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        h.query,
        'session.IdlingStarted',
        'drv-1',
        expect.objectContaining({
          siteName: 'Main Site',
          stationId: 'CS-1',
          transactionId: 'tx-1',
          gracePeriodMinutes: 10,
          idleFeePricePerMinute: '0.10',
          currency: 'USD',
        }),
        ['templates'],
        expect.objectContaining({ publish: h.publish }),
      );
      expect(h.track).toHaveBeenCalledTimes(1);
      expect(mockDispatchSystem).not.toHaveBeenCalled();
    });

    it('formats the idle fee gross when the driver chose gross prices', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([{ ...idleRow, price_display: 'gross', tax_rate: '0.2' }]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        h.query,
        'session.IdlingStarted',
        'drv-1',
        expect.objectContaining({
          idleFeePricePerMinute: '0.10',
          idleFeeFormatted: { amount: 0.12, currency: 'USD' },
          idleFeeIncludesTax: true,
          taxRatePercent: { taxRate: 0.2 },
        }),
        ['templates'],
        expect.objectContaining({ publish: h.publish }),
      );
    });

    it('emails the guest when the session has no driver', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([
        { ...idleRow, driver_id: null, guest_email: 'guest@example.com' },
      ]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(mockDispatchSystem).toHaveBeenCalledWith(
        h.query,
        'session.IdlingStarted',
        { email: 'guest@example.com' },
        expect.objectContaining({ stationId: 'CS-1' }),
        ['templates'],
      );
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('reads the settings before the claim, so a failed read leaves the period unclaimed', async () => {
      const h = makeHarness();
      const lost = Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' });
      mockGetCompanyPriceDisplay.mockRejectedValueOnce(lost);
      await expect(
        h.notify.dispatchDueIdlingNotification('sess-1', 'CS-1', 'tx-1', '2026-01-01T00:00:00Z'),
      ).rejects.toBe(lost);
      expect(h.query).not.toHaveBeenCalled();

      // The projection rerun claims the period and sends the notice.
      h.query.mockResolvedValueOnce([idleRow]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
    });

    it('sends nothing to a guest session without an email', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([{ ...idleRow, driver_id: null }]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(mockDispatchSystem).not.toHaveBeenCalled();
    });

    it('does nothing when the idle period was already claimed', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:00:00Z',
      );
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(mockDispatchSystem).not.toHaveBeenCalled();
    });

    it('claims only an open, unclaimed period that lasted the minimum at the given time (JB-2)', async () => {
      const h = makeHarness();
      h.query.mockResolvedValueOnce([]);
      await h.notify.dispatchDueIdlingNotification(
        'sess-1',
        'CS-1',
        'tx-1',
        '2026-01-01T00:01:00Z',
      );
      expect(IDLE_NOTICE_MIN_SECONDS).toBe(60);
      const [strings, ...values] = h.query.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const text = strings.join('?');
      expect(text).toContain('idle_started_at IS NOT NULL');
      expect(text).toContain('idle_notified_at IS DISTINCT FROM idle_started_at');
      expect(text).toContain("status = 'active'");
      expect(text).toContain('::timestamptz >= idle_started_at + make_interval(secs => ?)');
      expect(values).toContain('2026-01-01T00:01:00Z');
      expect(values).toContain(IDLE_NOTICE_MIN_SECONDS);
      // The claim never opens a period: only the station or meter signals do.
      expect(text).not.toContain('SET idle_started_at');
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });
  });
});
