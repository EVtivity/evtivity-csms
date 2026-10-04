// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../config.js', () => ({ db: { select: h.select, execute: h.execute } }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ col, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'),
    values,
  }),
}));

function settingRows(rows: unknown[]): void {
  h.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

async function load(): Promise<typeof import('../lib/remote-start-timeout.js')> {
  vi.resetModules();
  return import('../lib/remote-start-timeout.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getEvConnectionTimeoutDefaultSeconds', () => {
  it('reads the setting and caches it', async () => {
    const mod = await load();
    settingRows([{ value: 90 }]);
    expect(await mod.getEvConnectionTimeoutDefaultSeconds()).toBe(90);
    settingRows([{ value: 30 }]);
    expect(await mod.getEvConnectionTimeoutDefaultSeconds()).toBe(90);
    mod.clearEvConnectionTimeoutCache();
    expect(await mod.getEvConnectionTimeoutDefaultSeconds()).toBe(30);
  });

  it.each([[[]], [[{ value: 0 }]], [[{ value: 'x' }]], [[{ value: -5 }]]])(
    'falls back to 180 s for %j',
    async (rows) => {
      const mod = await load();
      settingRows(rows);
      expect(await mod.getEvConnectionTimeoutDefaultSeconds()).toBe(180);
    },
  );

  it('falls back to the default when the lookup fails', async () => {
    const mod = await load();
    h.select.mockImplementation(() => {
      throw new Error('db down');
    });
    expect(await mod.getEvConnectionTimeoutDefaultSeconds()).toBe(180);
    expect(h.warn).toHaveBeenCalled();
  });
});

describe('getStationConnectionTimeoutSeconds', () => {
  it('reads TxCtrlr.EVConnectionTimeOut for 2.1 and keeps the longest value', async () => {
    const mod = await load();
    h.execute.mockResolvedValue([{ value: '45' }, { value: '120' }, { value: null }]);
    expect(await mod.getStationConnectionTimeoutSeconds('sta_1', 'ocpp2.1')).toBe(120);
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['sta_1', 'TxCtrlr', 'EVConnectionTimeOut']);
  });

  it('reads the OCPP ConnectionTimeOut key for 1.6', async () => {
    const mod = await load();
    h.execute.mockResolvedValue([{ value: '30' }]);
    expect(await mod.getStationConnectionTimeoutSeconds('sta_2', 'ocpp1.6')).toBe(30);
    const query = h.execute.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toEqual(['sta_2', 'OCPP', 'ConnectionTimeOut']);
  });

  it('is null when the station reported none or only 0', async () => {
    const mod = await load();
    h.execute.mockResolvedValue([{ value: '0' }]);
    expect(await mod.getStationConnectionTimeoutSeconds('sta_1', 'ocpp2.1')).toBeNull();
  });
});

describe('remoteStartTimeoutDelayMs', () => {
  it('adds the margin to the reported timeout', async () => {
    const mod = await load();
    h.execute.mockResolvedValue([{ value: '30' }]);
    expect(await mod.remoteStartTimeoutDelayMs({ id: 'sta_1', ocppProtocol: 'ocpp1.6' })).toBe(
      90_000,
    );
  });

  it('uses the setting when the station reported nothing', async () => {
    const mod = await load();
    h.execute.mockResolvedValue([]);
    settingRows([{ value: 200 }]);
    expect(await mod.remoteStartTimeoutDelayMs({ id: 'sta_1', ocppProtocol: 'ocpp2.1' })).toBe(
      260_000,
    );
  });

  it('uses the setting when the station lookup fails', async () => {
    const mod = await load();
    h.execute.mockRejectedValue(new Error('db down'));
    settingRows([]);
    expect(await mod.remoteStartTimeoutDelayMs({ id: 'sta_1', ocppProtocol: null })).toBe(240_000);
    expect(h.warn).toHaveBeenCalled();
  });
});

describe('failUnstartedRemoteSession', () => {
  const row = {
    id: 'ses_1',
    station_id: 'sta_1',
    site_id: 'sit_1',
    driver_id: 'drv_1',
    reservation_id: null,
  };
  const session = {
    id: 'ses_1',
    stationUuid: 'sta_1',
    siteId: 'sit_1',
    driverId: 'drv_1',
    reservationId: null,
  };

  it('fails an active session without a reported transaction at cost 0', async () => {
    const mod = await load();
    h.execute.mockResolvedValueOnce([row]);
    expect(await mod.failUnstartedRemoteSession('ses_1')).toEqual({ outcome: 'failed', session });
    const query = h.execute.mock.calls[0]?.[0] as { text: string; values: unknown[] };
    expect(query.text).toContain("status = 'failed'");
    expect(query.text).toContain('final_cost_cents = 0');
    expect(query.text).toContain("cs.status = 'active'");
    expect(query.text).toContain('NOT EXISTS (SELECT 1 FROM transaction_events');
    expect(query.values).toEqual(['EVConnectTimeout', 'ses_1']);
  });

  it.each(['failed', 'faulted'])('reports a %s session without a transaction closed', async (s) => {
    const mod = await load();
    h.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...row, status: s, started: false }]);
    expect(await mod.failUnstartedRemoteSession('ses_1')).toEqual({ outcome: 'closed', session });
  });

  it('skips a session whose transaction started', async () => {
    const mod = await load();
    h.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...row, status: 'active', started: true }]);
    expect(await mod.failUnstartedRemoteSession('ses_1')).toEqual({ outcome: 'skipped' });
  });

  it('skips a session that ended with a transaction', async () => {
    const mod = await load();
    h.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...row, status: 'failed', started: true }]);
    expect(await mod.failUnstartedRemoteSession('ses_1')).toEqual({ outcome: 'skipped' });
  });

  it('reports an unknown session', async () => {
    const mod = await load();
    h.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await mod.failUnstartedRemoteSession('ses_x')).toEqual({ outcome: 'not_found' });
  });
});
