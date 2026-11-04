// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { results, fleetCharging } = vi.hoisted(() => ({
  results: [] as unknown[][],
  fleetCharging: { on: true },
}));

function chain(): Record<string, unknown> {
  const rows = results.shift() ?? [];
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
    self[m] = () => self;
  }
  self['then'] = (resolve: (v: unknown) => unknown) => resolve(rows);
  return self;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/departures.js')),
  ...(await import('@evtivity/database/src/schema/assets.js')),
  ...(await import('@evtivity/database/src/schema/load-management.js')),
  ...(await import('@evtivity/database/src/schema/charging.js')),
  ...(await import('@evtivity/database/src/schema/drivers.js')),
  db: { select: () => chain(), selectDistinctOn: () => chain() },
  isFleetChargingEnabled: async () => fleetCharging.on,
}));
vi.mock('../services/account-avatar.js', () => ({ withAvatars: async (rows: unknown[]) => rows }));

import { readLayoutSessionDepartures } from '../lib/site-layout-sessions.js';

const row = {
  id: 'vdp_1',
  sessionId: 'ses_1',
  departureAt: new Date('2026-11-03T13:30:00.000Z'),
  targetKind: 'energy',
  targetEnergyKwh: '120.00',
  targetSocPercent: null,
  readiness: 'at_risk',
  readinessReason: 'site_capacity',
  deliveredKwh: '45.50',
  shortfallKwh: '32.00',
  predictedReadyAt: new Date('2026-11-03T13:40:00.000Z'),
};

beforeEach(() => {
  results.length = 0;
  fleetCharging.on = true;
});

describe('readLayoutSessionDepartures', () => {
  it('gives each session its earliest departure with the readiness while the plan runs', async () => {
    results.push(
      [row, { ...row, id: 'vdp_2', departureAt: new Date('2026-11-04T13:30:00.000Z') }],
      [{ timezone: 'America/Los_Angeles' }],
      [{ strategy: 'departure_aware' }],
    );
    const out = await readLayoutSessionDepartures('sit_1', ['ses_1']);
    expect(out.get('ses_1')).toEqual({
      id: 'vdp_1',
      departureAt: '2026-11-03T13:30:00.000Z',
      timezone: 'America/Los_Angeles',
      readiness: 'at_risk',
      reason: 'site_capacity',
      targetKwh: 120,
      targetSocPercent: null,
      deliveredKwh: 45.5,
      shortfallKwh: 32,
      predictedReadyAt: '2026-11-03T13:40:00.000Z',
    });
    // No vehicle or driver id.
    expect(Object.keys(out.get('ses_1') ?? {})).not.toContain('vehicleId');
  });

  it('leaves the readiness out while fleet charging is off', async () => {
    fleetCharging.on = false;
    results.push([row], [{ timezone: 'UTC' }], [{ strategy: 'departure_aware' }]);
    const departure = (await readLayoutSessionDepartures('sit_1', ['ses_1'])).get('ses_1');
    expect(departure).toMatchObject({
      id: 'vdp_1',
      readiness: null,
      reason: null,
      shortfallKwh: null,
      predictedReadyAt: null,
      targetKwh: 120,
      deliveredKwh: 45.5,
    });
  });

  it('leaves the readiness out while the site uses another strategy', async () => {
    results.push([row], [{ timezone: 'UTC' }], [{ strategy: 'equal_share' }]);
    const departure = (await readLayoutSessionDepartures('sit_1', ['ses_1'])).get('ses_1');
    expect(departure?.readiness).toBeNull();
    expect(departure?.predictedReadyAt).toBeNull();
  });

  it('reports a state of charge target as a percent and reads nothing for no session', async () => {
    results.push(
      [{ ...row, targetKind: 'soc', targetEnergyKwh: null, targetSocPercent: 80 }],
      [{ timezone: 'UTC' }],
      [],
    );
    const departure = (await readLayoutSessionDepartures('sit_1', ['ses_1'])).get('ses_1');
    expect(departure).toMatchObject({ targetKwh: null, targetSocPercent: 80 });
    expect((await readLayoutSessionDepartures('sit_1', [])).size).toBe(0);
  });
});
