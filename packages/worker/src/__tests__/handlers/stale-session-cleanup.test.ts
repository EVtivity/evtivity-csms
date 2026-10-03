// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select(...).from().innerJoin().where()` resolves to the stale session
// list. `db.update().set().where()` resolves to undefined and captures the
// SET arg. The cost assembly (closeOpenSegment, priceSessionAt) is mocked; it
// is tested in @evtivity/database.

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

const updateSetArgs: unknown[] = [];
const updateWhere = vi.fn(() => Promise.resolve());
const mockUpdate = vi.fn(() => ({
  set: vi.fn((arg: unknown) => {
    updateSetArgs.push(arg);
    return { where: updateWhere };
  }),
}));

const {
  mockGetStaleSessionTimeoutHours,
  mockWriteReservationAudit,
  mockCloseOpenSegment,
  mockPriceSessionAt,
  mockPublish,
  mockClient,
} = vi.hoisted(() => ({
  mockGetStaleSessionTimeoutHours: vi.fn(),
  mockWriteReservationAudit: vi.fn().mockResolvedValue(undefined),
  mockCloseOpenSegment: vi.fn().mockResolvedValue(undefined),
  mockPriceSessionAt: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockClient: { __client: true },
}));

vi.mock('@evtivity/database', async () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  client: mockClient,
  chargingSessions: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    status: 'cs.status',
    updatedAt: 'cs.updatedAt',
  },
  chargingStations: { id: 'st.id', isOnline: 'st.isOnline', stationId: 'st.stationId' },
  getStaleSessionTimeoutHours: mockGetStaleSessionTimeoutHours,
  writeReservationAudit: mockWriteReservationAudit,
  closeOpenSegment: mockCloseOpenSegment,
  priceSessionAt: mockPriceSessionAt,
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
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
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
    currentCostCents: 500,
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
    updateSetArgs.length = 0;
    mockGetStaleSessionTimeoutHours.mockResolvedValue(4);
    mockWriteReservationAudit.mockResolvedValue(undefined);
    mockPriceSessionAt.mockResolvedValue(null);
    mockPublish.mockResolvedValue(undefined);
  });

  it('returns early without querying when timeout is disabled (<= 0)', async () => {
    mockGetStaleSessionTimeoutHours.mockResolvedValueOnce(0);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(log.debug).toHaveBeenCalledWith('Stale session cleanup disabled (timeout <= 0)');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns silently when no stale sessions are found', async () => {
    setStaleSessions([]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Stale session cleanup complete');
  });

  it('faults a stale session on an offline station without publishing a stop', async () => {
    setStaleSessions([baseSession({ stationIsOnline: false })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const set = updateSetArgs[0] as Record<string, unknown>;
    expect(set.status).toBe('faulted');
    expect(set.stoppedReason).toBe('StaleSession');
    expect(set.endedAt).toEqual(new Date('2026-06-01T01:00:00.000Z'));
    // No tariff snapshot -> finalCostCents falls back to currentCostCents (500).
    expect(set.finalCostCents).toBe(500);
    expect(set.currentCostCents).toBe(500);

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
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Stale session cleanup complete');
  });

  it('closes the open segment and stores the final cost from the cost assembly', async () => {
    const breakdown = {
      basis: 'net',
      netCents: 1143,
      taxCents: 91,
      grossCents: 1234,
      taxLines: [{ taxRate: 0.08, netCents: 1143, taxCents: 91 }],
      components: null,
    };
    mockPriceSessionAt.mockResolvedValue(breakdown);
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
    expect(mockPriceSessionAt).toHaveBeenCalledWith(mockClient, 'ses_1', endedAt, 1000);
    expect(updateSetArgs[0]).toMatchObject({
      status: 'faulted',
      finalCostCents: 1234,
      currentCostCents: 1234,
      netCents: 1143,
      taxCents: 91,
      costBreakdown: breakdown,
    });
  });

  it('prices a session without stored energy at 0 Wh', async () => {
    setStaleSessions([
      baseSession({ tariffId: 'tar_1', energyDeliveredWh: null, stationIsOnline: false }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockPriceSessionAt).toHaveBeenCalledWith(
      mockClient,
      'ses_1',
      new Date('2026-06-01T01:00:00.000Z'),
      0,
    );
  });

  it('keeps the last running cost when the cost assembly cannot price the session', async () => {
    setStaleSessions([baseSession({ tariffId: 'tar_1', stationIsOnline: false })]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    const set = updateSetArgs[0] as Record<string, unknown>;
    expect(set.finalCostCents).toBe(500);
    expect(set.currentCostCents).toBe(500);
    // The split stored with the running cost stays.
    expect(set).not.toHaveProperty('netCents');
    expect(set).not.toHaveProperty('costBreakdown');
  });

  it('falls back to currentCostCents (null) for final/current cost when no tariff snapshot exists', async () => {
    setStaleSessions([
      baseSession({ tariffId: null, currentCostCents: null, stationIsOnline: false }),
    ]);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    const set = updateSetArgs[0] as Record<string, unknown>;
    // finalCostCents stays null (== currentCostCents) when no tariff path runs.
    expect(set.finalCostCents).toBeNull();
    expect(set.currentCostCents).toBeNull();
    expect(mockPriceSessionAt).not.toHaveBeenCalled();
    expect(mockCloseOpenSegment).not.toHaveBeenCalled();
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
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Stale session cleanup complete');
  });

  it('logs an error and continues the loop when faulting a session throws', async () => {
    // First session's UPDATE rejects; second session must still be processed.
    updateWhere.mockRejectedValueOnce(new Error('update failed'));
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
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Stale session cleanup complete');
  });
});
