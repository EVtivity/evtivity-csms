// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select(...)` is used twice with different chain shapes:
//   1. active sessions: .from().innerJoin().where()  -> session list
//   2. closedIdleAgg:    .from().where()             -> [{ total }]
// A queued-result model keyed by call order drives both. `db.transaction(cb)`
// invokes cb with a tx that exposes update/insert chains (all no-ops here;
// the test asserts the tx ops were issued, not their SQL).

let selectQueue: unknown[][] = [];
let selectIndex = 0;
function setSelectResults(...results: unknown[][]): void {
  selectQueue = results;
  selectIndex = 0;
}
function nextSelectResult(): unknown[] {
  const r = selectQueue[selectIndex] ?? [];
  selectIndex++;
  return r;
}

// A thenable chain whose terminal resolves to the next queued select result.
function makeSelectChain(): Record<string, unknown> {
  const result = nextSelectResult();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return chain;
}
const mockSelect = vi.fn(() => makeSelectChain());

const txUpdateSet = vi.fn();
const txInsertValues = vi.fn();
function makeTx(): Record<string, unknown> {
  return {
    update: vi.fn(() => ({
      set: vi.fn((arg: unknown) => {
        txUpdateSet(arg);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((arg: unknown) => {
        txInsertValues(arg);
        return Promise.resolve();
      }),
    })),
  };
}
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
  await cb(makeTx());
});

const {
  mockIsSplitBillingEnabled,
  mockIsStationMessageEnabled,
  mockResolveTariff,
  mockPushAll,
  mockPublish,
} = vi.hoisted(() => ({
  mockIsSplitBillingEnabled: vi.fn(),
  mockIsStationMessageEnabled: vi.fn(),
  mockResolveTariff: vi.fn(),
  mockPushAll: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: mockSelect,
    transaction: mockTransaction,
  },
  chargingSessions: { id: 'cs.id', status: 'cs.status', stationId: 'cs.stationId' },
  chargingStations: { id: 'st.id', stationId: 'st.stationId', ocppProtocol: 'st.ocppProtocol' },
  sessionTariffSegments: {
    sessionId: 'sts.sessionId',
    endedAt: 'sts.endedAt',
    idleMinutes: 'sts.idleMinutes',
  },
  isSplitBillingEnabled: mockIsSplitBillingEnabled,
  isStationMessageEnabled: mockIsStationMessageEnabled,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('@evtivity/api/src/services/tariff.service.js', () => ({
  resolveTariff: mockResolveTariff,
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
    tariffId: 'tar_old',
    energyDeliveredWh: '1500',
    idleMinutes: '0',
    currentCostCents: 650,
    stationOcppId: 'CS-001',
    ocppProtocol: 'ocpp2.1',
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
    taxRate: '0.08',
    ...overrides,
  };
}

describe('tariffBoundaryCheckHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSelectResults();
    mockIsSplitBillingEnabled.mockResolvedValue(true);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    mockResolveTariff.mockResolvedValue(null);
    mockPushAll.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    txUpdateSet.mockClear();
    txInsertValues.mockClear();
  });

  it('returns early when both split-billing and station messages are disabled', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockIsStationMessageEnabled.mockResolvedValue(false);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPushAll).not.toHaveBeenCalled();
  });

  it('does not split or publish when the resolved tariff is unchanged', async () => {
    setSelectResults([activeSession({ tariffId: 'tar_same' })]);
    mockResolveTariff.mockResolvedValue(newTariff({ id: 'tar_same' }));
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockResolveTariff).toHaveBeenCalledWith('sta_1', 'drv_1');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not split or publish when no tariff resolves (null)', async () => {
    setSelectResults([activeSession()]);
    mockResolveTariff.mockResolvedValue(null);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('closes/opens segments, snapshots the new tariff, and publishes CostUpdated to OCPP 2.1', async () => {
    setSelectResults(
      [activeSession()], // active sessions
      [{ total: '0' }], // closedIdleAgg
    );
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Inside the tx: close-segment UPDATE, snapshot-session UPDATE, plus the
    // open-segment INSERT.
    expect(txInsertValues).toHaveBeenCalledTimes(1);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses_1',
        tariffId: 'tar_new',
        energyWhStart: '1500',
      }),
    );
    expect(txUpdateSet).toHaveBeenCalledTimes(2);
    // The session snapshot update carries the new tariff fields.
    const snapshotSet = txUpdateSet.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).tariffId === 'tar_new',
    );
    expect(snapshotSet).toBeDefined();
    expect(snapshotSet![0]).toMatchObject({
      tariffId: 'tar_new',
      tariffPricePerKwh: '0.30',
      tariffTaxRate: '0.08',
    });

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
      payload: { totalCost: 6.5, transactionId: 'tx-001' },
      version: 'ocpp2.1',
    });
    expect(typeof body.commandId).toBe('string');
  });

  it('handles null energy and missing closedIdleAgg row, and CostUpdated with null cost defaults to 0', async () => {
    setSelectResults(
      [activeSession({ energyDeliveredWh: null, currentCostCents: null })], // active sessions
      [], // closedIdleAgg returns no row -> total defaults to 0
    );
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    // Null energy -> 0; the open segment records energyWhStart '0'.
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ energyWhStart: '0' }));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockPublish.mock.calls[0] as [string, string])[1]) as {
      payload: { totalCost: number };
    };
    // currentCostCents null -> totalCost 0.
    expect(body.payload.totalCost).toBe(0);
  });

  it('splits the session but skips CostUpdated for OCPP 1.6 stations', async () => {
    setSelectResults([activeSession({ ocppProtocol: 'ocpp1.6' })], [{ total: '0' }]);
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips CostUpdated when ocppProtocol is null', async () => {
    setSelectResults([activeSession({ ocppProtocol: null })], [{ total: '0' }]);
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs the failed session and continues when one session in the batch rejects', async () => {
    // Two sessions: first's transaction rejects, second succeeds.
    setSelectResults(
      [
        activeSession({ sessionId: 'ses_bad' }),
        activeSession({ sessionId: 'ses_good', stationUuid: 'sta_2' }),
      ],
      [{ total: '0' }], // closedIdleAgg for ses_bad
      [{ total: '0' }], // closedIdleAgg for ses_good
    );
    mockResolveTariff.mockResolvedValue(newTariff());
    mockTransaction.mockImplementationOnce(async () => {
      throw new Error('tx failed');
    });
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_bad' }),
      'Tariff boundary check failed for session',
    );
    // The second session still ran its transaction.
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it('skips the split path entirely but still pushes messages when only station messages are enabled', async () => {
    mockIsSplitBillingEnabled.mockResolvedValue(false);
    mockIsStationMessageEnabled.mockResolvedValue(true);
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPushAll).toHaveBeenCalledTimes(1);
    expect(mockPushAll).toHaveBeenCalledWith(log);
  });

  it('runs both the split path and the station-message push when both are enabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValue(true);
    setSelectResults([activeSession()], [{ total: '0' }]);
    mockResolveTariff.mockResolvedValue(newTariff());
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing per-session when there are no active sessions but still pushes messages if enabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValue(true);
    setSelectResults([]); // no active sessions
    const log = makeLog();

    const { tariffBoundaryCheckHandler } = await import('../../handlers/tariff-boundary-check.js');
    await tariffBoundaryCheckHandler(log);

    expect(mockResolveTariff).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPushAll).toHaveBeenCalledTimes(1);
  });
});
