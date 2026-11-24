// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  FLEET_HISTORY,
  fleetHistoryBudget,
  fleetHistoryCandidates,
  selectFleetHistory,
} from '../seed-fleet-history-plan.js';
import type { FleetHistoryCandidate } from '../seed-fleet-history-plan.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-24T15:30:00Z');

function select(
  candidates: FleetHistoryCandidate[],
  overrides: Partial<Parameters<typeof selectFleetHistory>[0]> = {},
) {
  return selectFleetHistory({
    candidates,
    existingIds: new Set(),
    evseIds: ['evs_1', 'evs_2'],
    busy: [],
    budgetCents: null,
    ...overrides,
  });
}

describe('fleetHistoryCandidates', () => {
  it('spreads sessions over the 30 days before the run, a few on most days', () => {
    const plan = fleetHistoryCandidates(NOW, 150);
    const days = new Map<string, number>();
    for (const c of plan) days.set(c.day, (days.get(c.day) ?? 0) + 1);
    const windowStart = NOW.getTime() - FLEET_HISTORY.days * DAY_MS;
    expect(plan.every((c) => c.startedAt.getTime() >= windowStart)).toBe(true);
    expect(
      plan.every((c) => c.endedAt.getTime() <= NOW.getTime() - FLEET_HISTORY.endMarginMs),
    ).toBe(true);
    expect(days.size).toBeGreaterThanOrEqual(22);
    expect(Math.max(...days.values())).toBeLessThanOrEqual(3);
    expect(plan.length).toBeGreaterThanOrEqual(40);
    const recentDays = [...days.keys()].filter(
      (d) => Date.parse(`${d}T00:00:00Z`) >= NOW.getTime() - 7 * DAY_MS,
    );
    expect(recentDays.length).toBeGreaterThanOrEqual(5);
  });

  it('plans realistic energy, cost and duration', () => {
    for (const c of fleetHistoryCandidates(NOW, 11)) {
      expect(c.energyWh).toBeGreaterThanOrEqual(12_000);
      expect(c.energyWh).toBeLessThanOrEqual(42_000);
      const centsPerKwh = c.costCents / (c.energyWh / 1000);
      expect(centsPerKwh).toBeGreaterThanOrEqual(23.9);
      expect(centsPerKwh).toBeLessThanOrEqual(34.1);
      const hours = (c.endedAt.getTime() - c.startedAt.getTime()) / 3_600_000;
      // An 11 kW AC station at 85 percent: at least energy / 9.35 kW.
      expect(hours).toBeGreaterThanOrEqual(c.energyWh / 1000 / 9.35);
    }
  });

  it('caps the charging power at what a van accepts', () => {
    const fast = fleetHistoryCandidates(NOW, 350);
    const capped = fleetHistoryCandidates(NOW, FLEET_HISTORY.vehicleMaxKw);
    expect(fast.map((c) => c.endedAt.getTime())).toEqual(capped.map((c) => c.endedAt.getTime()));
  });

  it('gives a day the same ids and values on every run', () => {
    const early = fleetHistoryCandidates(NOW, 150);
    const later = fleetHistoryCandidates(new Date(NOW.getTime() + 2 * DAY_MS), 150);
    const laterById = new Map(later.map((c) => [c.id, c]));
    const shared = early.filter((c) => laterById.has(c.id));
    expect(shared.length).toBeGreaterThan(early.length / 2);
    for (const c of shared) expect(laterById.get(c.id)).toEqual(c);
    expect(early.every((c) => /^ses_nwh\d{9}$/.test(c.id))).toBe(true);
    expect(new Set(early.map((c) => c.id)).size).toBe(early.length);
    expect(new Set(early.map((c) => c.transactionId)).size).toBe(early.length);
  });

  it('plans no session that has not ended yet', () => {
    const atMidnight = new Date('2026-11-24T00:05:00Z');
    expect(fleetHistoryCandidates(atMidnight, 150).some((c) => c.day === '2026-11-24')).toBe(false);
  });
});

describe('selectFleetHistory', () => {
  const plan = fleetHistoryCandidates(NOW, 150);

  it('adds only what an earlier run left missing', () => {
    const firstRun = select(fleetHistoryCandidates(new Date(NOW.getTime() - 3 * DAY_MS), 150));
    const existingIds = new Set(firstRun.sessions.map((s) => s.id));
    const topUp = select(plan, { existingIds });
    expect(topUp.sessions.some((s) => existingIds.has(s.id))).toBe(false);
    const missing = plan.filter((c) => !existingIds.has(c.id));
    expect(topUp.sessions.map((s) => s.id).sort()).toEqual(missing.map((c) => c.id).sort());
    expect(
      missing.every((c) => Date.parse(`${c.day}T00:00:00Z`) >= NOW.getTime() - 4 * DAY_MS),
    ).toBe(true);
  });

  it('never overlaps another session on the same EVSE', () => {
    const target = plan[plan.length - 1];
    if (target == null) throw new Error('empty plan');
    const busy = [
      { evseId: 'evs_1', startedAt: target.startedAt, endedAt: target.endedAt },
      { evseId: 'evs_2', startedAt: target.startedAt, endedAt: target.endedAt },
    ];
    const both = select(plan, { busy });
    expect(both.sessions.some((s) => s.id === target.id)).toBe(false);
    expect(both.skippedBusy).toBeGreaterThanOrEqual(1);
    const one = select(plan, { busy: busy.slice(0, 1) });
    expect(one.sessions.find((s) => s.id === target.id)?.evseId).toBe('evs_2');
    const stationWide = select(plan, {
      busy: [{ evseId: null, startedAt: target.startedAt, endedAt: target.endedAt }],
    });
    expect(stationWide.sessions.some((s) => s.id === target.id)).toBe(false);
  });

  it('keeps the added cost within the budget, newest days first', () => {
    const total = plan.reduce((sum, c) => sum + c.costCents, 0);
    const budgetCents = Math.floor(total / 3);
    const capped = select(plan, { budgetCents });
    const added = capped.sessions.reduce((sum, s) => sum + s.costCents, 0);
    expect(added).toBeLessThanOrEqual(budgetCents);
    expect(capped.skippedBudget).toBeGreaterThan(0);
    const newest = [...plan].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    expect(capped.sessions[0]?.id).toBe(newest?.id);
    expect(select(plan, { budgetCents: 0 }).sessions).toEqual([]);
  });
});

describe('fleetHistoryBudget', () => {
  it('leaves the exposure cap share of the limit minus the exposure', () => {
    expect(FLEET_HISTORY.exposureCapPercent).toBeLessThan(80);
    expect(fleetHistoryBudget(500_000, 20_550)).toBe(350_000 - 20_550);
    expect(fleetHistoryBudget(50_000, 40_000)).toBe(0);
    expect(fleetHistoryBudget(null, 1_000_000)).toBeNull();
  });
});
