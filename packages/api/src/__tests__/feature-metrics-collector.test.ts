// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
const mockLoggerError = vi.fn();

type MockSql = { strings: string[]; values: unknown[] };

function sqlText(q: MockSql): string {
  return q.strings.join('?');
}

const mockInterfaceOn = vi.fn(() => Promise.resolve(true));

vi.mock('@evtivity/database', () => ({
  db: { execute: (q: MockSql) => mockExecute(sqlText(q)) },
  isVdv463Enabled: () => mockInterfaceOn(),
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const { collectFeatureMetrics } = await import('../services/feature-metrics-collector.js');
const m = await import('../plugins/metrics.js');

type LabelGauge = {
  get: () => Promise<{ values: { labels: Record<string, unknown>; value: number }[] }>;
};

async function single(gauge: LabelGauge): Promise<number | undefined> {
  return (await gauge.get()).values[0]?.value;
}

async function series(gauge: LabelGauge, label: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of (await gauge.get()).values) out[String(v.labels[label])] = v.value;
  return out;
}

/** Answers each query by a phrase of its SQL. */
function answer(map: [string, unknown[]][]): void {
  mockExecute.mockImplementation((text: string) => {
    const hit = map.find(([phrase]) => text.includes(phrase));
    return Promise.resolve(hit?.[1] ?? []);
  });
}

describe('collectFeatureMetrics', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockLoggerError.mockReset();
  });

  it('sets the worker, load management, departure, asset and depot gauges', async () => {
    answer([
      [
        'SELECT queue, status::text',
        [
          { queue: 'load-management', status: 'completed', count: 360 },
          { queue: 'cron-jobs', status: 'failed', count: 2 },
        ],
      ],
      ['AVG(duration_ms)', [{ queue: 'load-management', avg_ms: 42.5, max_ms: 900 }]],
      [
        'FROM cronjobs',
        [
          { name: 'departure-expand', failed: 0 },
          { name: 'payment-reconcile', failed: 1 },
        ],
      ],
      [
        'FROM site_load_management slm',
        [
          {
            enabled: 3,
            over_capacity: 1,
            send_failed: 1,
            applied_age_max: 120.5,
            supply_credit_kw: '12.5',
          },
        ],
      ],
      [
        "COALESCE(readiness, 'unplanned') AS readiness",
        [
          { readiness: 'at_risk', count: 2 },
          { readiness: 'unplanned', count: 4 },
        ],
      ],
      ['FROM vehicle_departure_notices', [{ kind: 'missed', count: 1 }]],
      ["status = 'completed'", [{ outcome: 'met', count: 7 }]],
      ['FROM site_charging_plans', [{ stale: 1, staleness_max: 75, runtime_max: 340 }]],
      [
        'FROM site_energy_assets a',
        [
          { type: 'battery', total: 2, stale: 1 },
          { type: 'solar', total: 1, stale: 0 },
        ],
      ],
      ['FROM depot_systems\n', [{ enabled: 2, locked: 1 }]],
      ['FROM depot_system_refused_requests r', [{ reason: 'unknown_vehicle', count: 3 }]],
    ]);

    await collectFeatureMetrics();

    expect(mockLoggerError).not.toHaveBeenCalled();
    expect((await m.workerJobsLastHour.get()).values).toEqual(
      expect.arrayContaining([
        { labels: { queue: 'load-management', status: 'completed' }, value: 360 },
        { labels: { queue: 'cron-jobs', status: 'failed' }, value: 2 },
      ]),
    );
    expect(await series(m.workerJobDurationAvgMs, 'queue')).toEqual({ 'load-management': 42.5 });
    expect(await series(m.workerJobDurationMaxMs, 'queue')).toEqual({ 'load-management': 900 });
    expect(await series(m.cronJobLastFailed, 'name')).toEqual({
      'departure-expand': 0,
      'payment-reconcile': 1,
    });
    expect(await single(m.loadManagementSitesEnabled)).toBe(3);
    expect(await single(m.loadManagementSitesOverCapacity)).toBe(1);
    expect(await single(m.loadManagementSitesSendFailed)).toBe(1);
    expect(await single(m.loadManagementAppliedAgeMaxSeconds)).toBe(120.5);
    expect(await single(m.loadManagementSupplyCreditKw)).toBe(12.5);
    expect(await series(m.departuresScheduled, 'readiness')).toEqual({ at_risk: 2, unplanned: 4 });
    // Both notice kinds export, so the missed alert reads 0 rather than no data.
    expect(await series(m.departureNoticesLastHour, 'kind')).toEqual({ at_risk: 0, missed: 1 });
    expect(await series(m.departuresCompletedLast24h, 'outcome')).toEqual({ met: 7 });
    expect(await single(m.chargingPlansStale)).toBe(1);
    expect(await single(m.chargingPlanStalenessMaxSeconds)).toBe(75);
    expect(await single(m.chargingPlanRuntimeMaxMs)).toBe(340);
    expect(await series(m.energyAssetsTotal, 'type')).toEqual({ battery: 2, solar: 1 });
    expect(await series(m.energyAssetsReadingStale, 'type')).toEqual({ battery: 1, solar: 0 });
    expect(await single(m.depotInterfaceEnabled)).toBe(1);
    expect(await single(m.depotSystemsEnabled)).toBe(2);
    expect(await single(m.depotSystemsAuthLocked)).toBe(1);
    expect(await series(m.depotSystemRefusedRequests, 'reason')).toEqual({ unknown_vehicle: 3 });
  });

  it('drops labels that no longer have rows and reads empty results as 0', async () => {
    answer([]);
    mockInterfaceOn.mockResolvedValueOnce(false);
    await collectFeatureMetrics();
    expect(await single(m.depotInterfaceEnabled)).toBe(0);
    expect(await series(m.workerJobDurationMaxMs, 'queue')).toEqual({});
    expect(await series(m.depotSystemRefusedRequests, 'reason')).toEqual({});
    expect(await single(m.loadManagementSitesEnabled)).toBe(0);
    expect(await single(m.chargingPlanStalenessMaxSeconds)).toBe(0);
    expect(await series(m.departureNoticesLastHour, 'kind')).toEqual({ at_risk: 0, missed: 0 });
  });

  it('keeps the previous values and logs when a query fails', async () => {
    answer([['FROM depot_systems\n', [{ enabled: 4, locked: 0 }]]]);
    await collectFeatureMetrics();
    expect(await single(m.depotSystemsEnabled)).toBe(4);

    mockExecute.mockImplementation((text: string) =>
      text.includes('FROM cronjobs') ? Promise.reject(new Error('db down')) : Promise.resolve([]),
    );
    await collectFeatureMetrics();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to collect feature metrics',
    );
    expect(await single(m.depotSystemsEnabled)).toBe(4);
  });

  it('skips a tick while the previous run is still going', async () => {
    const pending: ((value: unknown[]) => void)[] = [];
    mockExecute.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    const first = collectFeatureMetrics();
    const calls = mockExecute.mock.calls.length;
    await collectFeatureMetrics();
    expect(mockExecute.mock.calls.length).toBe(calls);
    for (const resolve of pending) resolve([]);
    await first;
  });
});
