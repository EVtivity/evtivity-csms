// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `db.select({...}).from(sites)` resolves to the site list.
//
// `db.execute(sql)` is harder to model than the other handlers because each
// site's four read blocks run via Promise.all and up to five sites run
// concurrently, so a call-order queue interleaves unpredictably. Instead we
// route results by inspecting the sql template: the joined `strings` identify
// the query kind (ping / yesterday / dayBoundaries / stations / uptime /
// sessions / revenue / upsert) and the bound `values` carry the siteId. Per-
// site overrides are keyed by siteId so concurrency is irrelevant.

let siteRows: unknown[] = [];
function setSites(rows: unknown[]): void {
  siteRows = rows;
}

const mockSelect = vi.fn(() => ({
  from: vi.fn(() => Promise.resolve(siteRows)),
}));

interface SiteData {
  yesterday?: string;
  stations?: { total: string; online: string };
  uptime?:
    | { uptime_percent: string; total_ports: string; stations_below_threshold: string }
    | undefined;
  sessions?: {
    total_sessions: string;
    day_sessions: string;
    total_energy_wh: string;
    day_energy_wh: string;
    total_electricity_cost_cents: string;
    day_electricity_cost_cents: string;
    active_sessions: string;
  };
  /** Revenue rows (session-revenue.ts) keyed 'true' for the snapshot day. */
  revenue?: Array<{
    key: string;
    taxRate: string;
    grossCents: number;
    source: string;
    count: number;
  }>;
}

const DEFAULT_SITE_DATA: Required<Omit<SiteData, 'uptime'>> & Pick<SiteData, 'uptime'> = {
  yesterday: '2026-06-03',
  stations: { total: '10', online: '8' },
  uptime: { uptime_percent: '99.5', total_ports: '20', stations_below_threshold: '1' },
  sessions: {
    total_sessions: '100',
    day_sessions: '12',
    total_energy_wh: '50000',
    day_energy_wh: '6000',
    total_electricity_cost_cents: '1200',
    day_electricity_cost_cents: '150',
    active_sessions: '3',
  },
  // Day: 10 sessions of 25.00 and one 50.00 fee (30000, 11 items). Earlier:
  // 78 sessions of 28.00 and one 16.00 fee (220000, 79 items).
  revenue: [
    { key: 'true', taxRate: '0', grossCents: 2500, source: 'session', count: 10 },
    { key: 'true', taxRate: '0', grossCents: 5000, source: 'fee', count: 1 },
    { key: 'false', taxRate: '0', grossCents: 2800, source: 'session', count: 78 },
    { key: 'false', taxRate: '0', grossCents: 1600, source: 'fee', count: 1 },
  ],
};

let pingRow: Record<string, string> | undefined;
let siteDataById: Record<string, SiteData> = {};
// Per-site forced rejections, optionally limited to a query kind.
let siteRejects: Record<string, { kind?: string }> = {};

function resetExecute(): void {
  pingRow = { avg_ping_latency_ms: '0', ping_success_rate: '100' };
  siteDataById = {};
  siteRejects = {};
  upsertCalls.length = 0;
}

const upsertCalls: Array<{ siteId: string; values: unknown[] }> = [];

function classify(strings: readonly string[]): string {
  const joined = strings.join('?');
  if (joined.includes('ocpp_server_health')) return 'ping';
  if (joined.includes('INSERT INTO dashboard_snapshots')) return 'upsert';
  if (joined.includes('AS yesterday')) return 'yesterday';
  if (joined.includes('AS day_start')) return 'dayBoundaries';
  if (joined.includes('AS total_sessions')) return 'sessions';
  if (joined.includes('all_ports')) return 'uptime';
  if (joined.includes('FROM charging_stations')) return 'stations';
  return 'unknown';
}

function dataFor(siteId: string): SiteData {
  return siteDataById[siteId] ?? {};
}

const mockExecute = vi.fn((arg: unknown) => {
  const { strings, values } = arg as { strings: readonly string[]; values: unknown[] };
  const kind = classify(strings);

  if (kind === 'ping') {
    return Promise.resolve(pingRow ? [pingRow] : []);
  }

  // siteId is the first bound value for every per-site query except
  // yesterday/dayBoundaries (which bind the timezone). For those two the
  // handler does not need a siteId, so we read it back from the call site by
  // tracking the most-recent-resolved boundary; simpler: yesterday and
  // dayBoundaries carry only constants, so route them generically using the
  // first matching site's data. Every per-site query's first/early value is
  // the siteId for stations/sessions/revenue/uptime/upsert.
  const siteId = (values.find((v) => typeof v === 'string' && v.startsWith('sit')) ?? '') as string;

  const reject = siteId ? siteRejects[siteId] : undefined;
  if (reject && (reject.kind == null || reject.kind === kind)) {
    return Promise.reject(new Error(`forced failure: ${siteId} ${kind}`));
  }

  const d = siteId ? dataFor(siteId) : {};

  switch (kind) {
    case 'yesterday':
      return Promise.resolve([{ yesterday: d.yesterday ?? DEFAULT_SITE_DATA.yesterday }]);
    case 'dayBoundaries':
      return Promise.resolve([
        { day_start: '2026-06-03T07:00:00.000Z', day_end: '2026-06-04T07:00:00.000Z' },
      ]);
    case 'stations':
      return Promise.resolve([d.stations ?? DEFAULT_SITE_DATA.stations]);
    case 'uptime':
      return Promise.resolve('uptime' in d ? [d.uptime] : [DEFAULT_SITE_DATA.uptime]);
    case 'sessions':
      return Promise.resolve([d.sessions ?? DEFAULT_SITE_DATA.sessions]);
    case 'upsert':
      upsertCalls.push({ siteId, values });
      return Promise.resolve([]);
    default:
      return Promise.resolve([]);
  }
});

vi.mock('@evtivity/database', () => ({
  db: {
    select: mockSelect,
    execute: mockExecute,
  },
  sites: { id: 'sites.id', timezone: 'sites.timezone' },
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
}));

// Revenue comes from the shared definition (session-revenue.ts); its SQL is
// covered by the API integration tests.
const mockQueryRevenue = vi.fn(
  async (input: { companyCurrency: string; where?: Array<{ values: unknown[] }> }) => {
    const found = input.where?.[0]?.values.find((v): v is string => typeof v === 'string');
    const siteId = found ?? '';
    if (siteRejects[siteId]?.kind === 'revenue') throw new Error(`forced failure: ${siteId}`);
    const { aggregateRevenueRows } = await vi.importActual<
      typeof import('@evtivity/api/src/lib/session-revenue.js')
    >('@evtivity/api/src/lib/session-revenue.js');
    return aggregateRevenueRows(dataFor(siteId).revenue ?? DEFAULT_SITE_DATA.revenue);
  },
);

vi.mock('@evtivity/api/src/lib/session-revenue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryRevenue: (input: { companyCurrency: string; where?: Array<{ values: unknown[] }> }) =>
    mockQueryRevenue(input),
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn((s: string) => ({ raw: s })) },
  ),
}));

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return log as unknown as Logger & typeof log;
}

function upsertFor(siteId: string): unknown[] {
  const found = upsertCalls.find((u) => u.siteId === siteId);
  if (!found) throw new Error(`no upsert recorded for ${siteId}`);
  return found.values;
}

describe('dashboardSnapshotHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSites([]);
    resetExecute();
  });

  it('sums electricity cost and revenue only in the company currency', async () => {
    setSites([{ id: 'sit_1', timezone: 'UTC' }]);
    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(makeLog());

    const callsOf = (kind: string) =>
      mockExecute.mock.calls
        .map(([arg]) => arg as { strings: readonly string[]; values: unknown[] })
        .filter((q) => classify(q.strings) === kind);
    const filterIn = (q: { values: unknown[] }, column: string) =>
      q.values.some((v) => {
        const frag = v as { strings?: readonly string[]; values?: unknown[] };
        return (
          frag.strings?.join('?').includes(column) === true && frag.values?.includes('EUR') === true
        );
      });

    const [sessions] = callsOf('sessions');
    expect(sessions && filterIn(sessions, 'UPPER(cs2.currency)')).toBe(true);
    // Revenue: the shared definition in the company currency, for this site.
    expect(mockQueryRevenue).toHaveBeenCalledWith(
      expect.objectContaining({ companyCurrency: 'EUR' }),
    );
    const where = mockQueryRevenue.mock.calls[0]?.[0].where ?? [];
    expect(where[0]?.values).toContain('sit_1');
  });

  it('returns early and logs when there are no sites', async () => {
    setSites([]);
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    expect(log.info).toHaveBeenCalledWith('No sites found, skipping dashboard snapshot');
    // No execute() ran: ping read is skipped when there are no sites.
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('reads the ping singleton, snapshots a single site, and upserts the computed row', async () => {
    setSites([{ id: 'sit_1', timezone: 'America/Los_Angeles' }]);
    pingRow = { avg_ping_latency_ms: '12.345', ping_success_rate: '99.1' };
    siteDataById = { sit_1: {} }; // all defaults
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    // ping + 6 per-site queries (yesterday, dayBoundaries, 3 reads, upsert) =
    // 7 execute calls; revenue goes through queryRevenue.
    expect(mockExecute).toHaveBeenCalledTimes(7);
    expect(mockQueryRevenue).toHaveBeenCalledTimes(1);

    // INSERT VALUES(...) bound params in source column order.
    expect(upsertFor('sit_1')).toEqual([
      'sit_1',
      '2026-06-03',
      10, // totalStations
      8, // onlineStations
      80, // onlinePercent = 8/10*100
      99.5, // uptimePercent (rounded)
      3, // activeSessions
      50000, // totalEnergyWh
      6000, // dayEnergyWh
      100, // totalSessions
      12, // daySessions
      8, // connected = onlineStations
      250000, // totalRevCents (sessions and fees)
      30000, // dayRevenueCents
      2766, // avgRevPerSession = round(243400 session revenue / 88 billed sessions)
      1200, // totalElectricityCostCents
      150, // dayElectricityCostCents
      90, // totalTransactions (billed sessions and fee charges)
      11, // dayTransactions
      20, // totalPorts
      1, // stationsBelowThreshold
      12.35, // avgPingLatencyMs rounded to 2dp
      99.1, // pingSuccessRate
      'EUR', // currency
    ]);

    expect(log.info).toHaveBeenCalledWith(
      { siteId: 'sit_1', snapshotDate: '2026-06-03' },
      'Site snapshot saved',
    );
    expect(log.info).toHaveBeenCalledWith({ siteCount: 1 }, 'Dashboard snapshot complete');
  });

  it('defaults ping metrics to 0 latency and 100 success when the singleton row is missing', async () => {
    setSites([{ id: 'sit_1', timezone: 'UTC' }]);
    pingRow = undefined; // no ping singleton row
    siteDataById = { sit_1: {} };
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    const values = upsertFor('sit_1');
    expect(values[21]).toBe(0); // avgPingLatencyMs default
    expect(values[22]).toBe(100); // pingSuccessRate default
  });

  it('handles zero stations: onlinePercent and avgRevPerSession both 0, uptime/ports default', async () => {
    setSites([{ id: 'sit_empty', timezone: 'UTC' }]);
    siteDataById = {
      sit_empty: {
        stations: { total: '0', online: '0' },
        uptime: undefined, // missing uptime row -> defaults
        sessions: {
          total_sessions: '0',
          day_sessions: '0',
          total_energy_wh: '0',
          day_energy_wh: '0',
          total_electricity_cost_cents: '0',
          day_electricity_cost_cents: '0',
          active_sessions: '0',
        },
        revenue: [],
      },
    };
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    const values = upsertFor('sit_empty');
    expect(values[2]).toBe(0); // totalStations
    expect(values[3]).toBe(0); // onlineStations
    expect(values[4]).toBe(0); // onlinePercent -> 0 (no divide-by-zero)
    expect(values[5]).toBe(100); // uptimePercent default when row missing
    expect(values[14]).toBe(0); // avgRevPerSession -> 0 (no sessions)
    expect(values[19]).toBe(0); // totalPorts default
    expect(values[20]).toBe(0); // stationsBelowThreshold default
  });

  it('snapshots every site across batch boundaries (CONCURRENCY=5)', async () => {
    const sites = Array.from({ length: 6 }, (_, i) => ({
      id: `sit_${String(i)}`,
      timezone: 'UTC',
    }));
    setSites(sites);
    siteDataById = Object.fromEntries(sites.map((s) => [s.id, {}]));
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    // 1 ping + 6 sites * 6 queries = 37 execute calls, plus one revenue query per site
    expect(mockExecute).toHaveBeenCalledTimes(1 + 6 * 6);
    expect(mockQueryRevenue).toHaveBeenCalledTimes(6);
    // One upsert per site.
    expect(upsertCalls).toHaveLength(6);
    const savedCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === 'Site snapshot saved',
    );
    expect(savedCalls).toHaveLength(6);
    expect(log.info).toHaveBeenCalledWith({ siteCount: 6 }, 'Dashboard snapshot complete');
  });

  it('logs the failed site and continues the batch when one site rejects', async () => {
    setSites([
      { id: 'sit_ok', timezone: 'UTC' },
      { id: 'sit_bad', timezone: 'UTC' },
    ]);
    siteDataById = { sit_ok: {}, sit_bad: {} };
    siteRejects = { sit_bad: { kind: 'stations' } }; // sit_bad fails on its station query
    const log = makeLog();

    const { dashboardSnapshotHandler } = await import('../../handlers/dashboard-snapshot.js');
    await dashboardSnapshotHandler(log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_bad' }),
      'Failed to snapshot site',
    );
    // The good site still produced its upsert + saved log; the run completes.
    expect(upsertCalls.map((u) => u.siteId)).toEqual(['sit_ok']);
    expect(log.info).toHaveBeenCalledWith(
      { siteId: 'sit_ok', snapshotDate: '2026-06-03' },
      'Site snapshot saved',
    );
    expect(log.info).toHaveBeenCalledWith({ siteCount: 2 }, 'Dashboard snapshot complete');
  });
});
