// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select(...).from().innerJoin().where()` resolves to the stale session
// list. `db.execute(sql)` resolves to queued results in call order
// (closedIdleAgg, segment-close UPDATE, optional split-segment SELECT).
// `db.update().set().where()` resolves to undefined and captures the SET arg.

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

let executeQueue: unknown[][] = [];
let executeIndex = 0;
function setExecuteResults(...results: unknown[][]): void {
  executeQueue = results;
  executeIndex = 0;
}
const mockExecute = vi.fn(() => {
  const r = executeQueue[executeIndex] ?? [];
  executeIndex++;
  return Promise.resolve(r);
});

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
  mockGetIdlingGracePeriodMinutes,
  mockIsSplitBillingEnabled,
  mockWriteReservationAudit,
  mockCalculateSessionCost,
  mockCalculateSplitSessionCost,
  mockPublish,
} = vi.hoisted(() => ({
  mockGetStaleSessionTimeoutHours: vi.fn(),
  mockGetIdlingGracePeriodMinutes: vi.fn(),
  mockIsSplitBillingEnabled: vi.fn(),
  mockWriteReservationAudit: vi.fn().mockResolvedValue(undefined),
  mockCalculateSessionCost: vi.fn(),
  mockCalculateSplitSessionCost: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    execute: mockExecute,
  },
  chargingSessions: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    status: 'cs.status',
    updatedAt: 'cs.updatedAt',
  },
  chargingStations: { id: 'st.id', isOnline: 'st.isOnline', stationId: 'st.stationId' },
  getStaleSessionTimeoutHours: mockGetStaleSessionTimeoutHours,
  getIdlingGracePeriodMinutes: mockGetIdlingGracePeriodMinutes,
  isSplitBillingEnabled: mockIsSplitBillingEnabled,
  writeReservationAudit: mockWriteReservationAudit,
}));

vi.mock('@evtivity/lib', () => ({
  calculateSessionCost: mockCalculateSessionCost,
  calculateSplitSessionCost: mockCalculateSplitSessionCost,
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
    currency: null,
    tariffId: null,
    tariffPricePerKwh: null,
    tariffPricePerMinute: null,
    tariffPricePerSession: null,
    tariffIdleFeePricePerMinute: null,
    tariffTaxRate: null,
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
    setExecuteResults();
    updateSetArgs.length = 0;
    mockGetStaleSessionTimeoutHours.mockResolvedValue(4);
    mockGetIdlingGracePeriodMinutes.mockResolvedValue(5);
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockWriteReservationAudit.mockResolvedValue(undefined);
    mockCalculateSessionCost.mockReturnValue({ totalCents: 0 });
    mockCalculateSplitSessionCost.mockReturnValue({ totalCents: 0 });
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

  it('computes single-tariff final cost when a tariff snapshot exists', async () => {
    mockCalculateSessionCost.mockReturnValue({ totalCents: 1234 });
    setStaleSessions([
      baseSession({
        currency: 'USD',
        tariffId: 'tar_1',
        tariffPricePerKwh: '0.25',
        tariffTaxRate: '0.08',
        idleMinutes: '10',
        idleStartedAt: new Date('2026-06-01T00:50:00.000Z'),
        stationIsOnline: false,
      }),
    ]);
    // closedIdleAgg, segment-close UPDATE
    setExecuteResults([{ total: '0' }], []);
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockCalculateSessionCost).toHaveBeenCalledTimes(1);
    const set = updateSetArgs[0] as Record<string, unknown>;
    expect(set.finalCostCents).toBe(1234);
    expect(set.currentCostCents).toBe(1234);
    // Split path not used.
    expect(mockCalculateSplitSessionCost).not.toHaveBeenCalled();
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
    expect(mockCalculateSessionCost).not.toHaveBeenCalled();
  });

  it('uses energy_wh_start and zero idle fallbacks for segments missing energy_wh_end/idle', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockCalculateSplitSessionCost.mockReturnValue({ totalCents: 999 });
    // energyDeliveredWh null -> energyWh defaults to 0 (line 71). closedIdleAgg
    // returns no row -> closedIdleSum defaults to 0 (line 97).
    setStaleSessions([
      baseSession({
        currency: 'USD',
        tariffId: 'tar_1',
        energyDeliveredWh: null,
        stationIsOnline: false,
      }),
    ]);
    setExecuteResults(
      [], // closedIdleAgg returns no row
      [], // segment-close UPDATE
      [
        // First segment closed normally.
        {
          started_at: '2026-06-01T00:00:00.000Z',
          ended_at: '2026-06-01T00:30:00.000Z',
          energy_wh_start: '0',
          energy_wh_end: '400',
          seg_idle_minutes: '0',
          currency: 'USD',
          price_per_kwh: '0.25',
          price_per_minute: '0',
          price_per_session: '0',
          idle_fee_price_per_minute: '0',
          tax_rate: '0',
        },
        // Second segment never closed: energy_wh_end and seg_idle_minutes null.
        {
          started_at: '2026-06-01T00:30:00.000Z',
          ended_at: null,
          energy_wh_start: '400',
          energy_wh_end: null,
          seg_idle_minutes: null,
          currency: 'USD',
          price_per_kwh: '0.30',
          price_per_minute: '0',
          price_per_session: '0',
          idle_fee_price_per_minute: '0',
          tax_rate: '0',
        },
        // Third segment with BOTH energy boundaries null -> the ultimate `?? 0`
        // fallbacks apply, yielding a 0 delta.
        {
          started_at: '2026-06-01T01:00:00.000Z',
          ended_at: null,
          energy_wh_start: null,
          energy_wh_end: null,
          seg_idle_minutes: null,
          currency: 'USD',
          price_per_kwh: '0.30',
          price_per_minute: '0',
          price_per_session: '0',
          idle_fee_price_per_minute: '0',
          tax_rate: '0',
        },
      ],
    );
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    const segments = mockCalculateSplitSessionCost.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(segments).toHaveLength(3);
    // Open segment: energy_wh_end null -> falls back to energy_wh_start (400),
    // so the delta is 400 - 400 = 0 instead of a large negative refund.
    expect(segments[1]!.energyDeliveredWh).toBe(0);
    expect(segments[1]!.idleMinutes).toBe(0);
    // Both boundaries null -> ultimate `?? 0` fallbacks yield a 0 delta.
    expect(segments[2]!.energyDeliveredWh).toBe(0);
    expect((updateSetArgs[0] as Record<string, unknown>).finalCostCents).toBe(999);
  });

  it('computes split-billing cost when enabled and more than one segment exists', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockCalculateSplitSessionCost.mockReturnValue({ totalCents: 4321 });
    setStaleSessions([
      baseSession({
        currency: 'USD',
        tariffId: 'tar_1',
        idleMinutes: '0',
        stationIsOnline: false,
      }),
    ]);
    setExecuteResults(
      [{ total: '0' }], // closedIdleAgg
      [], // segment-close UPDATE
      // split segments SELECT: two segments
      [
        {
          started_at: '2026-06-01T00:00:00.000Z',
          ended_at: '2026-06-01T00:30:00.000Z',
          energy_wh_start: '0',
          energy_wh_end: '500',
          seg_idle_minutes: '0',
          currency: 'USD',
          price_per_kwh: '0.25',
          price_per_minute: '0',
          price_per_session: '0',
          idle_fee_price_per_minute: '0',
          tax_rate: '0.08',
        },
        {
          started_at: '2026-06-01T00:30:00.000Z',
          ended_at: '2026-06-01T01:00:00.000Z',
          energy_wh_start: '500',
          energy_wh_end: '1000',
          seg_idle_minutes: '0',
          currency: 'USD',
          price_per_kwh: '0.30',
          price_per_minute: '0',
          price_per_session: '0',
          idle_fee_price_per_minute: '0',
          tax_rate: '0.08',
        },
      ],
    );
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockCalculateSplitSessionCost).toHaveBeenCalledTimes(1);
    const segments = mockCalculateSplitSessionCost.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.isFirstSegment).toBe(true);
    expect(segments[1]!.isFirstSegment).toBe(false);
    expect(segments[0]!.energyDeliveredWh).toBe(500); // 500 - 0
    expect(segments[1]!.energyDeliveredWh).toBe(500); // 1000 - 500
    const set = updateSetArgs[0] as Record<string, unknown>;
    expect(set.finalCostCents).toBe(4321);
  });

  it('falls back to single-tariff calc when split is enabled but only one segment exists', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockCalculateSessionCost.mockReturnValue({ totalCents: 777 });
    setStaleSessions([baseSession({ currency: 'USD', tariffId: 'tar_1', stationIsOnline: false })]);
    setExecuteResults(
      [{ total: '0' }], // closedIdleAgg
      [], // segment-close UPDATE
      [{ started_at: '2026-06-01T00:00:00.000Z', ended_at: null }], // one segment
    );
    const log = makeLog();

    const { staleSessionCleanupHandler } = await import('../../handlers/stale-session-cleanup.js');
    await staleSessionCleanupHandler(log);

    expect(mockCalculateSplitSessionCost).not.toHaveBeenCalled();
    expect(mockCalculateSessionCost).toHaveBeenCalledTimes(1);
    expect((updateSetArgs[0] as Record<string, unknown>).finalCostCents).toBe(777);
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
