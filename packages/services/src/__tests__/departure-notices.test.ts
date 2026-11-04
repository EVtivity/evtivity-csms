// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: [] as string[],
  rows: [] as unknown[][],
  backlog: [] as Array<{ id: string }>,
  recipients: [] as unknown[],
  claimed: new Set<string>(),
  claim: vi.fn(),
  complete: vi.fn(),
  fleetCharging: vi.fn(),
  markStale: vi.fn(),
  dispatch: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    h.queries.push(text);
    if (text.includes('site_load_management')) return Promise.resolve(h.backlog);
    if (text.includes('FROM vehicle_departures')) return Promise.resolve(h.rows.shift() ?? []);
    return Promise.resolve(h.recipients);
  },
  claimDepartureNotice: h.claim,
  completePassedDepartures: h.complete,
  isFleetChargingEnabled: h.fleetCharging,
  markSitePlanStale: h.markStale,
}));
vi.mock('@evtivity/lib', () => ({ dispatchSystemNotification: h.dispatch }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: h.publish }) }));
vi.mock('../template-dirs.js', () => ({ ALL_TEMPLATES_DIRS: ['/t'] }));

import {
  afterSitePlanWrite,
  closePassedDepartures,
  notifyDepartureAtRisk,
  notifyDepartureMissed,
  publishDepartureChanged,
  publishFleetChargingUpdated,
} from '../departure-notice.service.js';

const NOW = new Date('2026-11-01T02:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = { log, now: () => NOW, csmsUrl: 'https://csms.example.com/' };

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vdp_1',
    status: 'scheduled',
    departure_at: new Date('2026-11-01T05:30:00Z'),
    readiness: 'at_risk',
    readiness_reason: 'site_capacity',
    shortfall_kwh: '32.40',
    delivered_kwh: '10.00',
    target_kind: 'energy',
    target_energy_kwh: '80.00',
    target_soc_percent: null,
    outcome: null,
    site_id: 'sit_depot',
    site_name: 'North Depot',
    license_plate: 'BUS-12',
    make: 'Volvo',
    model: '7900',
    ...overrides,
  };
}

const operator = {
  id: 'usr_1',
  email: 'ops@example.com',
  phone: null,
  first_name: 'Ana',
  last_name: 'Lee',
  language: 'de',
  timezone: 'Europe/Berlin',
};

beforeEach(() => {
  h.queries.length = 0;
  h.rows.length = 0;
  h.backlog = [];
  h.recipients = [operator];
  h.claimed.clear();
  h.claim.mockReset();
  // The notice claim behaves like the unique (departure, kind) row.
  h.claim.mockImplementation((id: string, kind: string) => {
    const key = `${id}:${kind}`;
    if (h.claimed.has(key)) return Promise.resolve(false);
    h.claimed.add(key);
    return Promise.resolve(true);
  });
  h.dispatch.mockReset().mockResolvedValue({ delivered: [] });
  h.publish.mockReset().mockResolvedValue(undefined);
  h.complete.mockReset();
  h.fleetCharging.mockReset().mockResolvedValue(true);
  h.markStale.mockReset().mockResolvedValue(true);
  log.warn.mockReset();
});

describe('notifyDepartureAtRisk', () => {
  it('sends to the depot operators with the vehicle, shortfall, reason and readiness link', async () => {
    h.rows.push([row()]);
    expect(await notifyDepartureAtRisk(['vdp_1'], deps)).toBe(1);
    expect(h.queries[1]).toContain("p.permission IN ('fleets:read', 'fleets:write')");
    expect(h.queries[1]).toContain('u.has_all_site_access');
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'fleet.DepartureAtRisk',
      expect.objectContaining({ email: 'ops@example.com', language: 'de', userId: 'usr_1' }),
      expect.objectContaining({
        vehicleName: 'Volvo 7900',
        licensePlate: 'BUS-12',
        siteName: 'North Depot',
        departureAt: '2026-11-01T05:30:00.000Z',
        cannotMeet: false,
        shortfallKwh: '32.4',
        reasonSiteCapacity: true,
        readinessUrl: 'https://csms.example.com/sites/sit_depot?tab=fleet-readiness',
      }),
      ['/t'],
    );
  });

  it('sends one notice per departure under parallel calls and re-plans', async () => {
    h.rows.push([row()], [row()], [row()]);
    const results = await Promise.all([
      notifyDepartureAtRisk(['vdp_1'], deps),
      notifyDepartureAtRisk(['vdp_1'], deps),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await notifyDepartureAtRisk(['vdp_1'], deps)).toBe(0);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('never notifies a departed, completed or on-track departure', async () => {
    h.rows.push([
      row({ id: 'vdp_past', departure_at: new Date('2026-11-01T01:59:00Z') }),
      row({ id: 'vdp_done', status: 'completed' }),
      row({ id: 'vdp_ok', readiness: 'on_track' }),
      row({ id: 'vdp_none', readiness: null }),
    ]);
    expect(await notifyDepartureAtRisk(['vdp_past', 'vdp_done', 'vdp_ok', 'vdp_none'], deps)).toBe(
      0,
    );
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('marks a departure that cannot meet its target', async () => {
    h.rows.push([row({ readiness: 'cannot_meet', readiness_reason: null })]);
    await notifyDepartureAtRisk(['vdp_1'], deps);
    const vars = h.dispatch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(vars['cannotMeet']).toBe(true);
    expect(Object.keys(vars).some((k) => k.startsWith('reason'))).toBe(false);
  });

  it('logs a failed dispatch and never throws', async () => {
    h.rows.push([row()]);
    h.dispatch.mockRejectedValueOnce(new Error('smtp'));
    await expect(notifyDepartureAtRisk(['vdp_1'], deps)).resolves.toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('notifyDepartureMissed', () => {
  it('sends for a short or vehicle-less completed departure once', async () => {
    h.rows.push([
      row({ id: 'vdp_short', status: 'completed', outcome: 'short' }),
      row({ id: 'vdp_none', status: 'completed', outcome: 'no_vehicle' }),
      row({ id: 'vdp_met', status: 'completed', outcome: 'met' }),
    ]);
    expect(await notifyDepartureMissed(['vdp_short', 'vdp_none', 'vdp_met'], deps)).toBe(2);
    const vars = h.dispatch.mock.calls.map((c) => c[3] as Record<string, unknown>);
    expect(vars[0]).toMatchObject({ noVehicle: false, deliveredKwh: '10.0', targetKwh: '80.0' });
    expect(vars[1]).toMatchObject({ noVehicle: true });
    expect(h.dispatch.mock.calls[0]?.[1]).toBe('fleet.DepartureMissed');
  });
});

describe('closePassedDepartures', () => {
  it('completes, marks plans stale, publishes per site and sends missed notices while on', async () => {
    h.complete.mockResolvedValueOnce([
      { id: 'vdp_a', siteId: 'sit_1', outcome: 'met' },
      { id: 'vdp_b', siteId: 'sit_1', outcome: 'no_vehicle' },
      { id: 'vdp_c', siteId: 'sit_2', outcome: 'short' },
    ]);
    h.backlog = [{ id: 'vdp_b' }, { id: 'vdp_c' }];
    h.rows.push([
      row({ id: 'vdp_b', status: 'completed', outcome: 'no_vehicle' }),
      row({ id: 'vdp_c', status: 'completed', outcome: 'short' }),
    ]);
    const result = await closePassedDepartures({
      ...deps,
      pubsub: { publish: h.publish } as never,
    });
    expect(result).toEqual({ completed: 3, met: 1, short: 1, noVehicle: 1, notified: 2 });
    expect(h.markStale).toHaveBeenCalledWith('sit_1', 'departure_completed', log, {
      departureAwareOnly: true,
    });
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.publish.mock.calls[0]?.[1] as string)).toMatchObject({
      eventType: 'departure.changed',
      siteId: 'sit_1',
    });
    const backlog = h.queries.find((q) => q.includes('site_load_management'));
    expect(backlog).toContain("slm.strategy = 'departure_aware'");
    expect(backlog).toContain("n.kind = 'missed'");
  });

  it('sends missed notices a stopped run left behind when nothing new completed', async () => {
    h.complete.mockResolvedValueOnce([]);
    h.backlog = [{ id: 'vdp_left' }];
    h.rows.push([row({ id: 'vdp_left', status: 'completed', outcome: 'short' })]);
    const result = await closePassedDepartures(deps);
    expect(result).toMatchObject({ completed: 0, notified: 1 });
    expect(h.markStale).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps the completions and warns when the setting read fails', async () => {
    h.fleetCharging.mockRejectedValueOnce(new Error('db down'));
    h.complete.mockResolvedValueOnce([{ id: 'vdp_b', siteId: 'sit_1', outcome: 'no_vehicle' }]);
    const result = await closePassedDepartures(deps);
    expect(result).toMatchObject({ completed: 1, notified: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Departure missed notices not sent, retried next run',
    );
  });

  it('completes but sends no missed notice while fleet charging is off', async () => {
    h.fleetCharging.mockResolvedValue(false);
    h.complete.mockResolvedValueOnce([{ id: 'vdp_b', siteId: 'sit_1', outcome: 'no_vehicle' }]);
    const result = await closePassedDepartures(deps);
    expect(result.completed).toBe(1);
    expect(result.notified).toBe(0);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.includes('site_load_management'))).toBe(false);
  });

  it('does nothing else when no departure passed', async () => {
    h.complete.mockResolvedValueOnce([]);
    const result = await closePassedDepartures(deps);
    expect(result.completed).toBe(0);
    expect(h.markStale).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe('site events', () => {
  it('publishes fleetCharging.updated and departure.changed with the site, fail-open', async () => {
    await publishFleetChargingUpdated('sit_1', log);
    h.publish.mockRejectedValueOnce(new Error('redis down'));
    await publishDepartureChanged(['sit_2', 'sit_2'], log);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.publish.mock.calls[0]?.[1] as string)).toEqual({
      eventType: 'fleetCharging.updated',
      siteId: 'sit_1',
      stationId: null,
      sessionId: null,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('afterSitePlanWrite', () => {
  it('notifies only the departures the write moved into at risk or cannot meet', async () => {
    // afterSitePlanWrite reads the clock itself: the fixture departures lie after NOW.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    h.rows.push([row({ id: 'vdp_risk' }), row({ id: 'vdp_cannot', readiness: 'cannot_meet' })]);
    afterSitePlanWrite(
      'sit_depot',
      {
        changed: [
          { id: 'vdp_risk', readiness: 'at_risk', readinessReason: 'site_capacity' },
          { id: 'vdp_cannot', readiness: 'cannot_meet', readinessReason: null },
          { id: 'vdp_ok', readiness: 'on_track', readinessReason: null },
          { id: 'vdp_cleared', readiness: null, readinessReason: null },
        ],
      },
      log,
    );
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(2));
    const departureQuery = h.queries.find((q) => q.includes('FROM vehicle_departures'));
    expect(departureQuery).toBeDefined();
    const events = h.publish.mock.calls.map(
      (c) => (JSON.parse(c[1] as string) as { eventType: string }).eventType,
    );
    expect(events).toEqual(['fleetCharging.updated', 'departure.changed']);
  });

  it('publishes only fleetCharging.updated when no readiness changed', async () => {
    afterSitePlanWrite('sit_depot', { changed: [] }, log);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.publish.mock.calls[0]?.[1] as string)).toMatchObject({
      eventType: 'fleetCharging.updated',
      siteId: 'sit_depot',
    });
  });

  it('sends no notice when no departure turned at risk', () => {
    afterSitePlanWrite(
      'sit_depot',
      { changed: [{ id: 'vdp_ok', readiness: 'ready', readinessReason: null }] },
      log,
    );
    expect(h.queries).toEqual([]);
  });
});
