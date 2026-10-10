// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
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
  mockHeartbeat,
  mockSwitchTariffSegment,
  mockPriceSessionAt,
  mockStoreRunningCost,
  mockSendTariffChange,
  mockClient,
  mockUpdateSet,
} = vi.hoisted(() => ({
  mockIsSplitBillingEnabled: vi.fn(),
  mockIsStationMessageEnabled: vi.fn(),
  mockResolveTariff: vi.fn(),
  mockPushAll: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockHeartbeat: vi.fn(),
  mockSwitchTariffSegment: vi.fn(),
  mockPriceSessionAt: vi.fn(),
  mockStoreRunningCost: vi.fn(),
  mockSendTariffChange: vi.fn(),
  mockClient: { __client: true },
  mockUpdateSet: vi.fn(),
}));

const mockUpdate = vi.fn(() => ({
  set: (values: unknown) => {
    mockUpdateSet(values);
    return { where: vi.fn(() => Promise.resolve()) };
  },
}));

vi.mock('@evtivity/database', () => ({
  db: { select: mockSelect, update: mockUpdate },
  client: mockClient,
  chargingSessions: { id: 'cs.id', status: 'cs.status', stationId: 'cs.stationId' },
  chargingStations: { id: 'st.id', stationId: 'st.stationId', ocppProtocol: 'st.ocppProtocol' },
  isSplitBillingEnabled: mockIsSplitBillingEnabled,
  isStationMessageEnabled: mockIsStationMessageEnabled,
  getHeartbeatIntervalSeconds: mockHeartbeat,
  switchTariffSegment: mockSwitchTariffSegment,
  priceSessionAt: mockPriceSessionAt,
  storeRunningCost: mockStoreRunningCost,
  resolveStationTariff: mockResolveTariff,
  sendSessionTariffChange: mockSendTariffChange,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  sql: vi.fn(() => 'sql'),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('@evtivity/services/station-message.service', () => ({
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
    pricingGroupId: 'pgr_1',
    tariffPricePerKwh: '0.25',
    tariffPricePerMinute: null,
    tariffPricePerSession: null,
    tariffIdleFeePricePerMinute: null,
    tariffReservationFeePerMinute: null,
    tariffTaxRate: '0.08',
    energyDeliveredWh: '1500',
    stationOcppId: 'CS-001',
    ocppProtocol: 'ocpp2.1',
    stationOnline: true,
    stationLastActivityAt: new Date(Date.now() - 30_000),
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

// The module is imported after the mocks above are initialized. The first import loads the
// whole module graph, which under coverage on a busy machine took longer than one test's
// 5 s timeout, so it happens once here with its own timeout instead of inside the first test.
let mod: typeof import('../../handlers/tariff-boundary-check.js');
beforeAll(async () => {
  mod = await import('../../handlers/tariff-boundary-check.js');
}, 30_000);

describe('tariffBoundaryCheckHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessions = [];
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    mockResolveTariff.mockResolvedValue(null);
    mockPushAll.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    mockHeartbeat.mockResolvedValue(300);
    mockSwitchTariffSegment.mockResolvedValue({ fromTariffId: 'tar_old' });
    mockPriceSessionAt.mockResolvedValue(breakdown(712));
    mockStoreRunningCost.mockResolvedValue(true);
    mockSendTariffChange.mockResolvedValue('unchanged');
  });

  it('returns early when both split-billing and station messages are disabled', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPushAll).not.toHaveBeenCalled();
  });

  it('changes nothing when the open segment already has the tariff (the switch returns null)', async () => {
    // The session started on tar_start; its open segment is already tar_new,
    // or a MeterValues projection switched it first (B1).
    activeSessions = [activeSession()];
    mockSwitchTariffSegment.mockResolvedValue(null);
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    // The session's energy so far (1500 Wh) selects energy-threshold tariffs.
    expect(mockResolveTariff).toHaveBeenCalledWith(
      {
        stationUuid: 'sta_1',
        driverUuid: 'drv_1',
        at: expect.any(Date) as Date,
        sessionEnergyKwh: 1.5,
        pricingGroupId: 'pgr_1',
      },
      mockClient,
    );
    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPriceSessionAt).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('resolves a session without energy at 0 kWh', async () => {
    activeSessions = [activeSession({ energyDeliveredWh: null })];
    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(makeLog());

    expect(mockResolveTariff).toHaveBeenCalledWith(
      expect.objectContaining({
        stationUuid: 'sta_1',
        driverUuid: 'drv_1',
        sessionEnergyKwh: 0,
        pricingGroupId: 'pgr_1',
      }),
      mockClient,
    );
  });

  it('leaves the sessions of an offline or silent station alone (B6)', async () => {
    activeSessions = [
      activeSession({ stationOnline: false }),
      activeSession({ sessionId: 'ses_2', stationLastActivityAt: new Date(Date.now() - 600_000) }),
      activeSession({ sessionId: 'ses_3', stationLastActivityAt: null }),
    ];
    mockResolveTariff.mockResolvedValue(newTariff());

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(makeLog());

    expect(mockResolveTariff).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not split or publish when no tariff resolves (null)', async () => {
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(null);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('switches segments, stores the running cost, and publishes CostUpdated to OCPP 2.1', async () => {
    activeSessions = [activeSession()];
    const tariff = newTariff();
    mockResolveTariff.mockResolvedValue(tariff);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    const [client, params] = mockSwitchTariffSegment.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(client).toBe(mockClient);
    expect(params).toMatchObject({ sessionId: 'ses_1', tariff, energyWh: 1500 });
    // The switch computes the idle under the session row lock.
    expect(params).not.toHaveProperty('sessionIdleMinutes');

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

  it('sends the station the tariff from the boundary after switching segments (I11)', async () => {
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    await mod.tariffBoundaryCheckHandler(log);

    const switchedAt = (mockSwitchTariffSegment.mock.calls[0] as [unknown, { at: Date }])[1].at;
    expect(mockSendTariffChange).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ publish: mockPublish }),
      { sessionId: 'ses_1', at: switchedAt, energyWh: 1500 },
    );
  });

  it('sends no tariff change without a segment switch', async () => {
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(newTariff({ id: 'tar_old' }));
    mockSwitchTariffSegment.mockResolvedValue(null);

    await mod.tariffBoundaryCheckHandler(makeLog());

    expect(mockSendTariffChange).not.toHaveBeenCalled();
  });

  it('skips CostUpdated when the session cannot be priced or ended meanwhile (B14)', async () => {
    activeSessions = [activeSession({ energyDeliveredWh: null })];
    mockResolveTariff.mockResolvedValue(newTariff());
    mockPriceSessionAt.mockResolvedValue(null);
    const log = makeLog();

    await mod.tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ energyWh: 0 }),
    );
    expect(mockStoreRunningCost).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();

    // storeRunningCost writes active sessions only: false means the session
    // ended after the select, and the station keeps its final cost.
    activeSessions = [activeSession()];
    mockPriceSessionAt.mockResolvedValue(breakdown(712));
    mockStoreRunningCost.mockResolvedValue(false);
    await mod.tariffBoundaryCheckHandler(log);
    expect(mockStoreRunningCost).toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('splits the session but skips CostUpdated for OCPP 1.6 stations', async () => {
    activeSessions = [activeSession({ ocppProtocol: 'ocpp1.6' })];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips CostUpdated when ocppProtocol is null', async () => {
    activeSessions = [activeSession({ ocppProtocol: null })];
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
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

    const { tariffBoundaryCheckHandler } = mod;
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

    const { tariffBoundaryCheckHandler } = mod;
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

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing per-session when there are no active sessions but still pushes messages if enabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValue(true);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = mod;
    await tariffBoundaryCheckHandler(log);

    expect(mockResolveTariff).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });

  it('marks the payment gate due when a free start moves to a paid tariff (B3, TC-T3-08)', async () => {
    activeSessions = [
      activeSession({ tariffPricePerKwh: '0', tariffTaxRate: null, tariffPricePerSession: '0' }),
    ];
    mockResolveTariff.mockResolvedValue(newTariff());

    await mod.tariffBoundaryCheckHandler(makeLog());

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ paymentGateDueAt: expect.any(Date) });
  });

  it('marks nothing when the session started on a paid tariff', async () => {
    activeSessions = [activeSession()];
    mockResolveTariff.mockResolvedValue(newTariff());

    await mod.tariffBoundaryCheckHandler(makeLog());

    expect(mockSwitchTariffSegment).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('leaves a session without a pricing group unpriced (B7)', async () => {
    activeSessions = [activeSession({ pricingGroupId: null, tariffId: null })];
    mockResolveTariff.mockResolvedValue(newTariff());

    await mod.tariffBoundaryCheckHandler(makeLog());

    expect(mockResolveTariff).not.toHaveBeenCalled();
    expect(mockSwitchTariffSegment).not.toHaveBeenCalled();
  });
});
