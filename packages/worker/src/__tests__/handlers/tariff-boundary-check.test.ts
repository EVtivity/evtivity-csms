// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select(...).from().innerJoin().where()` resolves to the active sessions.
// The segment switch and the cost assembly (@evtivity/database
// session-pricing) are mocked; they are tested in @evtivity/database.

let activeSessions: unknown[] = [];
const mockSelect = vi.fn(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
    Promise.resolve(activeSessions).then(onF, onR);
  return chain;
});

const {
  mockIsSplitBillingEnabled,
  mockIsStationMessageEnabled,
  mockResolveTariff,
  mockPushAll,
  mockPublish,
  mockOpenSegmentTariffId,
  mockSwitchTariffSegment,
  mockPriceSessionAt,
  mockStoreRunningCost,
  mockClient,
} = vi.hoisted(() => ({
  mockIsSplitBillingEnabled: vi.fn(),
  mockIsStationMessageEnabled: vi.fn(),
  mockResolveTariff: vi.fn(),
  mockPushAll: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockOpenSegmentTariffId: vi.fn(),
  mockSwitchTariffSegment: vi.fn(),
  mockPriceSessionAt: vi.fn(),
  mockStoreRunningCost: vi.fn(),
  mockClient: { __client: true },
}));

vi.mock('@evtivity/database', () => ({
  db: { select: mockSelect },
  client: mockClient,
  chargingSessions: { id: 'cs.id', status: 'cs.status', stationId: 'cs.stationId' },
  chargingStations: { id: 'st.id', stationId: 'st.stationId', ocppProtocol: 'st.ocppProtocol' },
  isSplitBillingEnabled: mockIsSplitBillingEnabled,
  isStationMessageEnabled: mockIsStationMessageEnabled,
  openSegmentTariffId: mockOpenSegmentTariffId,
  switchTariffSegment: mockSwitchTariffSegment,
  priceSessionAt: mockPriceSessionAt,
  storeRunningCost: mockStoreRunningCost,
  resolveStationTariff: mockResolveTariff,
  sessionIdleMinutesAt: (session: { idleStartedAt: Date | null; idleMinutes: number }, at: Date) =>
    session.idleStartedAt == null
      ? session.idleMinutes
      : session.idleMinutes + (at.getTime() - session.idleStartedAt.getTime()) / 60000,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('@evtivity/api/src/services/station-message.service.js', () => ({
  pushAllMessagesToAllStations: mockPushAll,
}));

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return log as unknown as Logger & typeof log;
}

function activeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'ses_1',
    transactionId: 'tx-001',
    stationUuid: 'sta_1',
    driverId: 'drv_1',
    tariffId: 'tar_start',
    energyDeliveredWh: '1500',
    idleMinutes: '0',
    idleStartedAt: null,
    currentCostCents: 650,
    stationOcppId: 'CS-001',
    ocppProtocol: 'ocpp2.1',
    stationOnline: true,
    ...overrides,
  };
}

function newTariff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tar_new',
    pricePerKwh: '0.30',
    pricePerMinute: '0',
    pricePerSession: '0',
    idleFeePricePerMinute: '0',
    reservationFeePerMinute: null,
    taxRate: '0.08',
    ...overrides,
  };
}

const breakdown = (grossCents: number) => ({
  basis: 'net',
  netCents: grossCents,
  taxCents: 0,
  grossCents,
  taxLines: [{ taxRate: 0, netCents: grossCents, taxCents: 0 }],
  components: null,
});

describe('tariffBoundaryCheckHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessions = [];
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    mockResolveTariff.mockResolvedValue(null);
    mockPushAll.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    mockOpenSegmentTariffId.mockResolvedValue('tar_old');
    mockSwitchTariffSegment.mockResolvedValue(undefined);
    mockPriceSessionAt.mockResolvedValue(breakdown(712));
    mockStoreRunningCost.mockResolvedValue(true);
  });

  it('returns early when both split-billing and station messages are disabled', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPushAll).not.toHaveBeenCalled();
  });

  it('compares with the open segment tariff, not the session start tariff', async () => {
    // The session started on tar_start; its open segment is already tar_new.
    activeSessions = [activeSession()];
    mockOpenSegmentTariffId.mockResolvedValue('tar_new');
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    // The session's energy so far (1500 Wh) selects energy-threshold tariffs.
    expect(mockResolveTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', sessionEnergyKwh: 1.5 },
      mockClient,
    );
    expect(mockOpenSegmentTariffId).toHaveBeenCalledWith(mockClient, 'ses_1');
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('resolves a session without energy at 0 kWh', async () => {
    activeSessions = [activeSession({ energyDeliveredWh: null })];
    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(makeLog());

    expect(mockResolveTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', sessionEnergyKwh: 0 },
      mockClient,
    );
  });

  it('falls back to the session tariff when no segment is open', async () => {
    activeSessions = [activeSession({ tariffId: 'tar_new' })];
    mockOpenSegmentTariffId.mockResolvedValue(null);
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
  });

  it('does not split or publish when no tariff resolves (null)', async () => {
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(null);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('switches segments, stores the running cost, and publishes CostUpdated to OCPP 2.1', async () => {
    activeSessions = [
      activeSession({
        idleMinutes: '4',
        idleStartedAt: new Date(Date.now() - 6 * 60_000),
      }),
    ];
    const tariff = newTariff();
    mockResolveTariff.mockResolvedValue(tariff);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    const [client, params] = mockSwitchTariffSegment.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(client).toBe(mockClient);
    expect(params).toMatchObject({ sessionId: 'ses_1', tariff, energyWh: 1500 });
    // The running idle period belongs to the closing segment: 4 + about 6 minutes.
    expect(params.sessionIdleMinutes as number).toBeCloseTo(10, 0);

    expect(mockPriceSessionAt).toHaveBeenCalledWith(mockClient, 'ses_1', params.at, 1500);
    expect(mockStoreRunningCost).toHaveBeenCalledWith(mockClient, 'ses_1', breakdown(712));

    expect(log.info).toHaveBeenCalledWith(
      { sessionId: 'ses_1', oldTariffId: 'tar_old', newTariffId: 'tar_new' },
      'Tariff boundary: split session at new tariff',
    );

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockPublish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      stationId: 'CS-001',
      action: 'CostUpdated',
      payload: { totalCost: 7.12, transactionId: 'tx-001' },
      version: 'ocpp2.1',
    });
    expect(typeof body.commandId).toBe('string');
  });

  it('sends the stored running cost when the session can no longer be priced or stored', async () => {
    activeSessions = [activeSession({ energyDeliveredWh: null, currentCostCents: null })];
    mockResolveTariff.mockResolvedValue(newTariff());
    mockPriceSessionAt.mockResolvedValue(null);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ energyWh: 0 }),
    );
    expect(mockStoreRunningCost).not.toHaveBeenCalled();
    const body = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as {
      payload: { totalCost: number };
    };
    // currentCostCents null -> totalCost 0.
    expect(body.payload.totalCost).toBe(0);

    mockPublish.mockClear();
    activeSessions = [activeSession()];
    mockPriceSessionAt.mockResolvedValue(breakdown(712));
    mockStoreRunningCost.mockResolvedValue(false);
    await tariffBoundaryCheckHandler(log);
    const ended = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as {
      payload: { totalCost: number };
    };
    expect(ended.payload.totalCost).toBe(6.5);
  });

  it('splits the session but skips CostUpdated for OCPP 1.6 stations', async () => {
    activeSessions = [activeSession({ ocppProtocol: 'ocpp1.6' })];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('splits the session but skips CostUpdated while the station is offline', async () => {
    activeSessions = [activeSession({ stationOnline: false })];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips CostUpdated when ocppProtocol is null', async () => {
    activeSessions = [activeSession({ ocppProtocol: null })];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs the failed session and continues when one session in the batch rejects', async () => {
    activeSessions = [
      activeSession({ sessionId: 'ses_bad' }),
      activeSession({ sessionId: 'ses_good', stationUuid: 'sta_2' }),
    ];
    mockResolveTariff.mockResolvedValue(newTariff());
    mockSwitchTariffSegment.mockRejectedValueOnce(new Error('tx failed'));
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_bad' }),
      'Tariff boundary check failed for session',
    );
    // The second session still switched.
    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(2);
  });

  it('skips the split path entirely but still pushes messages when only station messages are enabled', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockIsStationMessageEnabled.mockResolvedValue(true);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPushAll).toHaveBeenCalledTimes(1);
    expect(mockPushAll).toHaveBeenCalledWith(log);
  });

  it('runs both the split path and the station-message push when both are enabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValue(true);
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing per-session when there are no active sessions but still pushes messages if enabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValue(true);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockResolveTariff).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });
});
