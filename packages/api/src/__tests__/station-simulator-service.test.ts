// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updateReturning: [] as unknown[],
    updates: [] as Record<string, unknown>[],
  };
  const chain = (result: () => unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'set']) c[m] = vi.fn(() => c);
    c['returning'] = vi.fn(() => Promise.resolve(result()));
    c['then'] = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return c;
  };
  const tx = {
    select: vi.fn(() => chain(() => state.selects.shift() ?? [])),
    update: vi.fn(() => {
      const c = chain(() => state.updateReturning);
      c['set'] = vi.fn((v: Record<string, unknown>) => {
        state.updates.push(v);
        return c;
      });
      return c;
    }),
  };
  const db = { transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return {
    state,
    db,
    tx,
    writeAudit: vi.fn(),
    disableCssPair: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: h.db,
  chargingStations: { id: 'id', stationId: 'stationId', isSimulator: 'isSimulator' },
  cssStations: { stationId: 'cssStationId', enabled: 'enabled' },
  stationAuditLog: {},
  writeAudit: h.writeAudit,
}));
vi.mock('../lib/css-pairing.js', () => ({ disableCssPair: h.disableCssPair }));

import { confirmRealStation } from '../services/station-simulator.service.js';

const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selects = [];
  h.state.updateReturning = [];
  h.state.updates = [];
});

describe('confirmRealStation', () => {
  it('clears the flag and conflict, disables the pairing and audits', async () => {
    const conflictAt = new Date('2026-10-04T10:00:00Z');
    h.state.selects = [
      [{ stationId: 'CS-1', isSimulator: true, simulatorConflictAt: conflictAt }],
      [{ enabled: true }],
    ];
    h.state.updateReturning = [{ id: 'sta_1' }];

    await expect(confirmRealStation('sta_1', ctx)).resolves.toEqual({ changed: true });

    expect(h.state.updates[0]).toMatchObject({ isSimulator: false, simulatorConflictAt: null });
    expect(h.disableCssPair).toHaveBeenCalledWith('CS-1', h.tx);
    const [, args] = h.writeAudit.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({
      entityId: 'sta_1',
      action: 'simulator_toggled',
      actor: 'operator',
      actorUserId: 'usr_1',
      before: { isSimulator: true, simulatorEnabled: true, simulatorConflictAt: conflictAt },
      after: { isSimulator: false, simulatorEnabled: false, simulatorConflictAt: null },
    });
  });

  it('is a no-op for a station that is not flagged', async () => {
    h.state.selects = [[{ stationId: 'CS-1', isSimulator: false, simulatorConflictAt: null }]];
    h.state.updateReturning = [];

    await expect(confirmRealStation('sta_1', ctx)).resolves.toEqual({ changed: false });
    expect(h.disableCssPair).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('throws STATION_NOT_FOUND for an unknown station', async () => {
    h.state.selects = [[]];
    await expect(confirmRealStation('sta_x', ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'STATION_NOT_FOUND',
    });
  });
});
