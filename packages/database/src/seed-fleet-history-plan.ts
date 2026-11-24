// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charging history of the Northwind demo fleet as plain data (no database
// import): completed account sessions over the 30 days before the seed run, so
// the fleet dashboard and the fleet Sessions tab show recent activity. Each
// UTC day plans its own sessions from a generator seeded by the date, so every
// run plans the same ids for a day and a rerun inserts only what is missing.

import { demoBetween, demoRandom } from './lib/demo-random.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export const FLEET_HISTORY = {
  /** The rolling window: today and the 29 UTC days before it. */
  days: 30,
  /**
   * The seed keeps the fleet's credit exposure at or below this share of the
   * credit limit, under the default 80 percent warning level, so the demo
   * fleet never warns or refuses a card because of seeded history.
   */
  exposureCapPercent: 70,
  idPrefix: 'ses_nwh',
  transactionPrefix: 'txn_nwh_',
  /** A planned session counts only once it ended this long before the run. */
  endMarginMs: 10 * MINUTE_MS,
  /** Charging power a delivery van accepts, whatever the station offers. */
  vehicleMaxKw: 80,
  /** Station power when its connectors have no rating. */
  defaultStationKw: 11,
} as const;

/** Who started the session: the pool card, the member card, or a member in the app. */
export type FleetHistoryPayerSlot = 'poolCard' | 'memberCard' | 'accountDriver' | 'secondDriver';

const PAYER_SLOTS: readonly FleetHistoryPayerSlot[] = [
  'poolCard',
  'memberCard',
  'accountDriver',
  'secondDriver',
];

export interface FleetHistoryCandidate {
  id: string;
  transactionId: string;
  /** The UTC day (YYYY-MM-DD) the session belongs to. */
  day: string;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  /** Final cost including tax. */
  costCents: number;
  payer: FleetHistoryPayerSlot;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every session the window plans, oldest day first: 0 to 3 sessions a day
 * (none on about one day in ten), 12 to 42 kWh at 24 to 34 cents per kWh, a
 * duration from the energy at the station's power, and only sessions that
 * ended `endMarginMs` before `now`.
 */
export function fleetHistoryCandidates(now: Date, stationKw: number): FleetHistoryCandidate[] {
  const kw = Math.min(
    stationKw > 0 ? stationKw : FLEET_HISTORY.defaultStationKw,
    FLEET_HISTORY.vehicleMaxKw,
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const latestEnd = now.getTime() - FLEET_HISTORY.endMarginMs;
  const candidates: FleetHistoryCandidate[] = [];
  for (let back = FLEET_HISTORY.days - 1; back >= 0; back--) {
    const dayStart = today - back * DAY_MS;
    const day = utcDay(dayStart);
    const key = day.replaceAll('-', '');
    const rand = demoRandom(Number(key));
    const r = rand();
    const count = r < 0.1 ? 0 : r < 0.3 ? 1 : r < 0.75 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      // Morning, midday and evening shifts, so a day's sessions never overlap on one EVSE.
      const startedAt = new Date(
        dayStart +
          (11 + i * 4 + demoBetween(rand, 0, 2)) * HOUR_MS +
          demoBetween(rand, 0, 59) * MINUTE_MS,
      );
      const energyWh = demoBetween(rand, 12_000, 42_000);
      const costCents = Math.round((energyWh / 1000) * demoBetween(rand, 24, 34));
      const chargeMinutes = Math.round((energyWh / 1000 / (kw * 0.85)) * 60);
      const endedAt = new Date(
        startedAt.getTime() + (chargeMinutes + demoBetween(rand, 4, 12)) * MINUTE_MS,
      );
      const payer = PAYER_SLOTS[demoBetween(rand, 0, PAYER_SLOTS.length - 1)] ?? 'accountDriver';
      if (endedAt.getTime() > latestEnd) continue;
      candidates.push({
        id: `${FLEET_HISTORY.idPrefix}${key}${String(i + 1)}`,
        transactionId: `${FLEET_HISTORY.transactionPrefix}${key}_${String(i + 1)}`,
        day,
        startedAt,
        endedAt,
        energyWh,
        costCents,
        payer,
      });
    }
  }
  return candidates;
}

/**
 * What the seed may still add to the fleet's exposure: the cap share of the
 * limit minus the exposure, never below 0. Null when the fleet has no limit.
 */
export function fleetHistoryBudget(
  limitCents: number | null,
  exposureCents: number,
): number | null {
  if (limitCents == null) return null;
  const cap = Math.floor((limitCents * FLEET_HISTORY.exposureCapPercent) / 100);
  return Math.max(cap - exposureCents, 0);
}

/** A session already on the station, which a planned session must not overlap. */
export interface FleetHistoryBusy {
  /** Null: a session without an EVSE, which blocks the whole station. */
  evseId: string | null;
  startedAt: Date;
  endedAt: Date;
}

export interface FleetHistorySelectionInput {
  candidates: FleetHistoryCandidate[];
  /** Candidate ids already in the database (an earlier run): skipped, already counted. */
  existingIds: ReadonlySet<string>;
  /** The station's EVSEs in order; `[null]` for a station without one. */
  evseIds: Array<string | null>;
  busy: FleetHistoryBusy[];
  /** Null: no credit limit, no cap. */
  budgetCents: number | null;
}

export interface FleetHistorySelection {
  sessions: Array<FleetHistoryCandidate & { evseId: string | null }>;
  /** Candidates left out because every EVSE was in use. */
  skippedBusy: number;
  /** Candidates left out because they would pass the exposure cap. */
  skippedBudget: number;
}

function overlaps(a: { startedAt: Date; endedAt: Date }, b: { startedAt: Date; endedAt: Date }) {
  return a.startedAt.getTime() < b.endedAt.getTime() && b.startedAt.getTime() < a.endedAt.getTime();
}

/**
 * The candidates to insert, newest first so the recent days fill before the
 * budget runs out: not inserted yet, on the first EVSE free for the whole
 * session, and within the budget.
 */
export function selectFleetHistory(input: FleetHistorySelectionInput): FleetHistorySelection {
  const taken: FleetHistoryBusy[] = [...input.busy];
  const sessions: FleetHistorySelection['sessions'] = [];
  let skippedBusy = 0;
  let skippedBudget = 0;
  let remaining = input.budgetCents;
  const newestFirst = [...input.candidates].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  );
  for (const candidate of newestFirst) {
    if (input.existingIds.has(candidate.id)) continue;
    const evseId = input.evseIds.find(
      (id) => !taken.some((b) => (b.evseId == null || b.evseId === id) && overlaps(b, candidate)),
    );
    if (evseId === undefined) {
      skippedBusy++;
      continue;
    }
    if (remaining != null && candidate.costCents > remaining) {
      skippedBudget++;
      continue;
    }
    if (remaining != null) remaining -= candidate.costCents;
    taken.push({ evseId, startedAt: candidate.startedAt, endedAt: candidate.endedAt });
    sessions.push({ ...candidate, evseId });
  }
  return { sessions, skippedBusy, skippedBudget };
}
