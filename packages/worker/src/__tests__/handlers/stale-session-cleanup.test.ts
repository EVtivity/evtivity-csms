// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select(...).from().innerJoin().where()` resolves to the stale session
// list. closeOpenSegment and faultUnbilledSession are mocked; they are tested
// in @evtivity/database.

let staleSessionRows: unknown[] = [];
function setStaleSessions(rows: unknown[]): void {
  staleSessionRows = rows;
}

const selectWhere = vi.fn(() => Promise.resolve(staleSessionRows));
const mockSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    innerJoin: vi.fn(() => ({
      where: selectWhere,
    })),
  })),
}));

const {
  mockGetStaleSessionTimeoutHours,
  mockWriteReservationAudit,
  mockCloseOpenSegment,
  mockFaultUnbilledSession,
  mockPublish,
  mockClient,
  mockCancelOpenSessionHold,
} = vi.hoisted(() => ({
  mockGetStaleSessionTimeoutHours: vi.fn(),
  mockWriteReservationAudit: vi.fn().mockResolvedValue(undefined),
  mockCloseOpenSegment: vi.fn().mockResolvedValue(undefined),
  mockFaultUnbilledSession: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockClient: { __client: true },
  mockCancelOpenSessionHold: vi.fn(),
}));

vi.mock('@evtivity/payments', () => ({
  cancelOpenSessionHold: mockCancelOpenSessionHold,
}));

vi.mock('../../lib/payments.js', () => ({
  paymentContext: (logger: unknown) => ({ registry: 'registry', logger }),
}));

vi.mock('@evtivity/database', async () => ({
  db: {
    select: mockSelect,
  },
  client: mockClient,
  chargingSessions: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    status: 'cs.status',
    updatedAt: 'cs.updatedAt',
    endRequestReason: 'cs.endRequestReason',
  },
  chargingStations: { id: 'st.id', isOnline: 'st.isOnline', stationId: 'st.stationId' },
  getStaleSessionTimeoutHours: mockGetStaleSessionTimeoutHours,
  writeReservationAudit: mockWriteReservationAudit,
  closeOpenSegment: mockCloseOpenSegment,
  faultUnbilledSession: mockFaultUnbilledSession,
  sessionIdleMinutesAt: (
    await vi.importActual<typeof import('../../../../database/src/lib/session-pricing.js')>(
      '../../../../database/src/lib/session-pricing.js',
    )
  ).sessionIdleMinutesAt,
}));

vi.mock('../../../../database/src/lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: vi.fn(),
}));
vi.mock('../../../../database/src/lib/pricing-settings.js', () => ({
  isSplitBillingEnabled: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return log as unknown as Logger & typeof log;
}

// A stale session with no tariff snapshot, so cost calc is skipped.
function baseSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_1',
    stationId: 'sta_1',
    driverId: 'drv_1',
    transactionId: 'tx-001',
    startedAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T01:00:00.000Z'),
    energyDeliveredWh: '1000',
    tariffId: null,
    idleStartedAt: null,
    idleMinutes: '0',
    reservationId: null,
    stationIsOnline: false,
    stationOcppId: 'CS-001',
    ocppProtocol: 'ocpp2.1',
    ...overrides,
  };
}

describe('staleSessionCleanupHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStaleSessions([]);
    mockGetStaleSessionTimeoutHours.mockResolvedValue(4);
    mockWriteReservationAudit.mockResolvedValue(undefined);
    mockFaultUnbilledSession.mockResolvedValue(true);
    mockPublish.mockResolvedValue(undefined);
    mockCancelOpenSessionHold.mockResolvedValue({ status: 'none' });
  });

  it('cancels the open hold of a session it faulted, without a capture', async () => {
    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    setStaleSessions([baseSession()]);
    mockCancelOpenSessionHold.mockResolvedValueOnce({ status: 'cancelled', paymentRecordId: 9 });
    const log = makeLog();

    await staleSessionCleanupHandler(log);

    expect(mockCancelOpenSessionHold).toHaveBeenCalledWith(
      'ses_1',
      'Stale session faulted',
      expect.objectContaining({ registry: 'registry' }),
    );
    expect(mockFaultUnbilledSession).toHaveBeenCalledWith(mockClient, {
      sessionId: 'ses_1',
      reason: 'StaleSession',
      endedAt: new Date('2026-06-01T01:00:00.000Z'),
    });
  });

  it('leaves the hold of a session that ended meanwhile to its settlement (P5)', async () => {
    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    setStaleSessions([baseSession()]);
    mockFaultUnbilledSession.mockResolvedValueOnce(false);

    await staleSessionCleanupHandler(makeLog());

    expect(mockCancelOpenSessionHold).not.toHaveBeenCalled();
  });

  it('logs a warning and continues when the hold cancel fails (fail-open)', async () => {
    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    setStaleSessions([baseSession(), baseSession({ id: 'ses_2', transactionId: 'tx-002' })]);
    mockCancelOpenSessionHold.mockRejectedValueOnce(new Error('provider down'));
    const log = makeLog();

    await staleSessionCleanupHandler(log);

    expect(mockCancelOpenSessionHold).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Failed to cancel the hold of a stale session',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns early without querying when timeout is disabled (<= 0)', async () => {
    mockGetStaleSessionTimeoutHours.mockResolvedValueOnce(0);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(log.debug).toHaveBeenCalledWith('Stale session cleanup disabled (timeout <= 0)');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
  });

  it('skips sessions with a pending end request (they end billed through the OCPP server)', async () => {
    const { and, isNull } = await import('drizzle-orm');
    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(makeLog());
    expect(isNull).toHaveBeenCalledWith('cs.endRequestReason');
    expect(vi.mocked(and).mock.calls[0]).toContainEqual({ isNull: 'cs.endRequestReason' });
  });

  it('returns silently when no stale sessions are found', async () => {
    setStaleSessions([]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Stale session cleanup complete');
  });

  it('faults a stale session on an offline station without publishing a stop', async () => {
    setStaleSessions([baseSession({ stationIsOnline: false })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    // Faulted at the last update and not billed (cost 0, audit N6).
    expect(mockFaultUnbilledSession).toHaveBeenCalledTimes(1);
    expect(mockFaultUnbilledSession).toHaveBeenCalledWith(mockClient, {
      sessionId: 'ses_1',
      reason: 'StaleSession',
      endedAt: new Date('2026-06-01T01:00:00.000Z'),
    });
    // No tariff snapshot: no segment to close.
    expect(mockCloseOpenSegment).not.toHaveBeenCalled();

    // Offline station: no RequestStopTransaction.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Stale session cleanup complete');
  });

  it('publishes RequestStopTransaction with version to ocpp_commands for an online station', async () => {
    setStaleSessions([
      baseSession({ stationIsOnline: true, ocppProtocol: 'ocpp1.6', transactionId: 'tx-99' }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockPublish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      stationId: 'CS-001',
      action: 'RequestStopTransaction',
      payload: { transactionId: 'tx-99' },
      version: 'ocpp1.6',
    });
    expect(typeof body.commandId).toBe('string');
    expect((body.commandId as string).length).toBeGreaterThan(0);
  });

  it('omits the version field when the station has no ocppProtocol', async () => {
    setStaleSessions([baseSession({ stationIsOnline: true, ocppProtocol: null })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    const raw = (mockPublish.mock.calls[0] as [string, string])[1];
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).not.toHaveProperty('version');
  });

  it('does not abort the loop when the stop publish throws (fail-open)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    setStaleSessions([
      baseSession({ id: 'ses_a', stationIsOnline: true }),
      baseSession({
        id: 'ses_b',
        stationIsOnline: false,
        updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_a' }),
      'Failed to send RequestStopTransaction for stale session',
    );
    // Both sessions still got faulted; the failed publish did not stop the loop.
    expect(mockFaultUnbilledSession).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Stale session cleanup complete');
  });

  it('closes the open segment, then faults the session without billing it', async () => {
    setStaleSessions([
      baseSession({
        tariffId: 'tar_1',
        idleMinutes: '10',
        idleStartedAt: new Date('2026-06-01T00:50:00.000Z'),
        stationIsOnline: false,
      }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    const endedAt = new Date('2026-06-01T01:00:00.000Z');
    // 10 accumulated idle minutes plus the open period 00:50 to 01:00.
    expect(mockCloseOpenSegment).toHaveBeenCalledWith(mockClient, 'ses_1', endedAt, 1000, 20);
    expect(mockFaultUnbilledSession).toHaveBeenCalledWith(mockClient, {
      sessionId: 'ses_1',
      reason: 'StaleSession',
      endedAt,
    });
    expect(mockCloseOpenSegment.mock.invocationCallOrder[0]).toBeLessThan(
      mockFaultUnbilledSession.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('closes the open segment of a session without stored energy at 0 Wh', async () => {
    setStaleSessions([
      baseSession({ tariffId: 'tar_1', energyDeliveredWh: null, stationIsOnline: false }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockCloseOpenSegment).toHaveBeenCalledWith(
      mockClient,
      'ses_1',
      new Date('2026-06-01T01:00:00.000Z'),
      0,
      0,
    );
  });

  it('writes a reservation audit when the session is linked to a reservation', async () => {
    setStaleSessions([baseSession({ reservationId: 'rsv_1', stationIsOnline: false })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockWriteReservationAudit).toHaveBeenCalledTimes(1);
    expect(mockWriteReservationAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'session_failed',
        actor: 'system',
        notes: 'session ses_1: faulted: StaleSession',
      }),
      undefined,
      log,
    );
  });

  it('logs a warning but continues when the reservation audit write throws (fail-open)', async () => {
    mockWriteReservationAudit.mockRejectedValueOnce(new Error('audit table missing'));
    setStaleSessions([baseSession({ reservationId: 'rsv_1', stationIsOnline: false })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1', reservationId: 'rsv_1' }),
      'Failed to write session_failed reservation audit on stale cleanup',
    );
    // Session was still faulted despite audit failure.
    expect(mockFaultUnbilledSession).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Stale session cleanup complete');
  });

  it('logs an error and continues the loop when faulting a session throws', async () => {
    // First session's UPDATE rejects; second session must still be processed.
    mockFaultUnbilledSession.mockRejectedValueOnce(new Error('update failed'));
    setStaleSessions([
      baseSession({ id: 'ses_bad', stationIsOnline: false }),
      baseSession({
        id: 'ses_good',
        stationIsOnline: false,
        updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_bad' }),
      'Failed to close stale session',
    );
    // Loop continued: second session's UPDATE ran.
    expect(mockFaultUnbilledSession).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Stale session cleanup complete');
  });
});
