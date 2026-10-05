// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';

const writeAuditMock = vi.fn();
vi.mock('@evtivity/database', () => ({
  stationAuditLog: { name: 'station_audit_log' },
  writeAudit: (...args: unknown[]) => writeAuditMock(...args) as unknown,
}));

import {
  classifySimulatorConnection,
  hasSimulatorMarker,
  reconcileSimulatorIdentity,
  type SimulatorConnection,
} from '../server/middleware/simulator-identity.js';

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof reconcileSimulatorIdentity>[2];
}

// Records every query's text; resolves each call with the next queued result.
function createSql(results: unknown[][]) {
  const queue = [...results];
  const queries: string[] = [];
  const run = (strings: TemplateStringsArray): Promise<unknown[]> => {
    queries.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(run, {
    json: (v: unknown) => v,
    begin: async (fn: (tx: typeof run) => Promise<unknown>) => fn(run),
  });
  return { sql: sql as unknown as Parameters<typeof reconcileSimulatorIdentity>[0], queries };
}

const base: SimulatorConnection = {
  stationDbId: 'sta_1',
  stationId: 'CS-1',
  securityProfile: 1,
  markerPresent: false,
  pairing: { enabled: true, markerSeenAt: new Date('2026-10-01T00:00:00Z') },
  remoteAddress: '10.0.0.5',
};

describe('hasSimulatorMarker', () => {
  it('is true only for the simulator header value', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    expect(hasSimulatorMarker(req({ 'x-evtivity-simulator': 'css' }))).toBe(true);
    expect(hasSimulatorMarker(req({ 'x-evtivity-simulator': 'other' }))).toBe(false);
    expect(hasSimulatorMarker(req({}))).toBe(false);
  });
});

describe('classifySimulatorConnection', () => {
  it('treats a marked connection as the simulator on any profile', () => {
    for (const securityProfile of [0, 1, 2, 3]) {
      expect(
        classifySimulatorConnection({ ...base, securityProfile, markerPresent: true }),
      ).toEqual({ kind: 'simulator' });
    }
  });

  it('treats an authenticated unmarked connection as a real station (profiles 1-3)', () => {
    for (const securityProfile of [1, 2, 3]) {
      expect(classifySimulatorConnection({ ...base, securityProfile })).toEqual({
        kind: 'real_station',
      });
    }
  });

  it('treats an unmarked connection as a real station without a pairing or with a disabled one', () => {
    expect(classifySimulatorConnection({ ...base, pairing: null })).toEqual({
      kind: 'real_station',
    });
    expect(
      classifySimulatorConnection({ ...base, pairing: { enabled: false, markerSeenAt: null } }),
    ).toEqual({ kind: 'real_station' });
  });

  it('records a conflict on profile 0, where nothing is authenticated', () => {
    expect(classifySimulatorConnection({ ...base, securityProfile: 0 })).toEqual({
      kind: 'conflict',
      reason: 'unauthenticated_profile',
    });
  });

  it('records a conflict when the enabled simulator never showed its marker (older release)', () => {
    expect(
      classifySimulatorConnection({ ...base, pairing: { enabled: true, markerSeenAt: null } }),
    ).toEqual({ kind: 'conflict', reason: 'simulator_not_verified' });
  });
});

describe('reconcileSimulatorIdentity', () => {
  beforeEach(() => {
    writeAuditMock.mockReset();
  });

  it('records the first marker sighting and clears an earlier conflict', async () => {
    const { sql, queries } = createSql([[{ id: 'css_1' }], []]);
    await reconcileSimulatorIdentity(
      sql,
      { ...base, markerPresent: true, pairing: { enabled: true, markerSeenAt: null } },
      createLogger(),
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('UPDATE css_stations SET marker_seen_at = now()');
    expect(queries[1]).toContain('SET simulator_conflict_at = NULL');
  });

  it('does not write when the marker was already seen', async () => {
    const { sql, queries } = createSql([]);
    await reconcileSimulatorIdentity(sql, { ...base, markerPresent: true }, createLogger());
    expect(queries).toHaveLength(0);
  });

  it('self-heals a real station: clears the flag, disables the pairing, logs and audits', async () => {
    const { sql, queries } = createSql([[{ id: 'sta_1' }], [], []]);
    const logger = createLogger();
    await reconcileSimulatorIdentity(sql, { ...base, securityProfile: 2 }, logger);
    expect(queries[0]).toContain('SET is_simulator = false, simulator_conflict_at = NULL');
    expect(queries[1]).toContain('UPDATE css_stations SET enabled = false');
    expect(queries[2]).toContain('INSERT INTO connection_logs');
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const [, args] = writeAuditMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({
      entityId: 'sta_1',
      action: 'simulator_toggled',
      actor: 'ocpp',
      before: { isSimulator: true, simulatorEnabled: true },
      after: { isSimulator: false, simulatorEnabled: false },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing more when the flag was already cleared', async () => {
    const { sql, queries } = createSql([[]]);
    await reconcileSimulatorIdentity(sql, base, createLogger());
    expect(queries).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('records a conflict on profile 0', async () => {
    const { sql, queries } = createSql([]);
    const logger = createLogger();
    await reconcileSimulatorIdentity(sql, { ...base, securityProfile: 0 }, logger);
    expect(queries[0]).toContain('SET simulator_conflict_at = now()');
    expect(queries[1]).toContain('INSERT INTO connection_logs');
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open when the database write fails', async () => {
    const failing = Object.assign(() => Promise.reject(new Error('db down')), {
      json: (v: unknown) => v,
      begin: () => Promise.reject(new Error('db down')),
    }) as unknown as Parameters<typeof reconcileSimulatorIdentity>[0];
    const logger = createLogger();
    await expect(reconcileSimulatorIdentity(failing, base, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-1', outcome: 'real_station' }),
      'Simulator identity check failed; connection accepted',
    );
  });
});
