// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Day replay of the site Layout tab: the station states, charging and power
// of one day (GET /v1/sites/:id/layout/replay) turned into the layout
// stations of a moment, so the 2D and 3D views draw a replayed moment exactly
// like a live one. No three.js here.

import type { LayoutStation } from './StationCard';

export interface ReplayConnector {
  evseId: number;
  connectorId: number | null;
  initialStatus: string | null;
  changes: Array<{ at: string; status: string }>;
}

export interface ReplayStation {
  id: string;
  initialOnline: boolean;
  onlineChanges: Array<{ at: string; online: boolean }>;
  connectors: ReplayConnector[];
  sessions: Array<{ startedAt: string; endedAt: string | null; energyWh: number }>;
  power: Array<{ at: string; kw: number }>;
}

export interface ReplayDay {
  date: string;
  timezone: string;
  /** Start of the day in the site's time zone. */
  from: string;
  /** The next midnight, exclusive. */
  to: string;
  stations: ReplayStation[];
}

/** Power samples are 5-minute averages; a sample counts for its bucket only (no sample: 0 kW). */
export const REPLAY_BUCKET_MS = 5 * 60_000;

/** Replay speeds: replayed minutes per real second. */
export const REPLAY_SPEEDS = [5, 15, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Connector statuses that mean a car is plugged in, as the layout reply names them. */
const PLUGGED = new Set([
  'occupied',
  'charging',
  'preparing',
  'finishing',
  'suspendedev',
  'suspendedevse',
]);

/** A connector status of the replay (OCPP or stored spelling) in the layout's lowercase form. */
export function normalizeConnectorStatus(status: string | null): string {
  if (status == null) return 'unknown';
  const s = status.toLowerCase();
  return PLUGGED.has(s) ? 'occupied' : s;
}

function lastBefore<T extends { at: string }>(changes: readonly T[], at: number): T | null {
  let found: T | null = null;
  for (const c of changes) {
    if (Date.parse(c.at) <= at) found = c;
    else break;
  }
  return found;
}

/** Whether a session runs at `at`; an open session runs until `openUntil` (now, or the end of the day). */
export function sessionAt(
  sessions: ReplayStation['sessions'],
  at: number,
  openUntil: number,
): { energyWh: number } | null {
  for (const s of sessions) {
    const start = Date.parse(s.startedAt);
    const end = s.endedAt != null ? Date.parse(s.endedAt) : openUntil;
    if (start <= at && at < end) {
      // Energy so far, spread evenly over the session.
      const share = end > start ? (at - start) / (end - start) : 1;
      return { energyWh: Math.round(s.energyWh * Math.min(1, Math.max(0, share))) };
    }
  }
  return null;
}

/** The power draw of the bucket holding `at`, or 0. */
export function powerAt(power: ReplayStation['power'], at: number): number {
  const sample = lastBefore(power, at);
  if (sample == null) return 0;
  return at - Date.parse(sample.at) < REPLAY_BUCKET_MS ? sample.kw : 0;
}

export interface ReplayFrame {
  stations: LayoutStation[];
  power: Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>;
}

/**
 * The layout at moment `at` (ms) of a replayed day: each station's online
 * state, connector statuses, a session's energy so far and its power draw.
 * Stations the replay does not cover keep their layout but show offline.
 * Live-only data (display message, maintenance, the session and driver) is
 * left out. `now` ends sessions still open on today's replay.
 */
export function replayFrame(
  day: ReplayDay,
  stations: readonly LayoutStation[],
  at: number,
  now: number = Date.now(),
): ReplayFrame {
  const byId = new Map(day.stations.map((s) => [s.id, s]));
  const openUntil = Math.min(Date.parse(day.to), now);
  const power = new Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>();
  const frame = stations.map((station): LayoutStation => {
    const r = byId.get(station.id);
    if (r == null) {
      return {
        ...station,
        isOnline: false,
        displayMessage: null,
        inMaintenance: false,
        session: null,
      };
    }
    const online = lastBefore(r.onlineChanges, at)?.online ?? r.initialOnline;
    const session = sessionAt(r.sessions, at, openUntil);
    const statusOf = (evseId: number, connectorId: number): string | null => {
      const c =
        r.connectors.find((x) => x.evseId === evseId && x.connectorId === connectorId) ??
        r.connectors.find((x) => x.evseId === evseId && x.connectorId == null);
      if (c == null) return null;
      return normalizeConnectorStatus(lastBefore(c.changes, at)?.status ?? c.initialStatus);
    };
    const withStatus = station.evses.map((evse) => ({
      ...evse,
      connectors: evse.connectors.map((conn) => ({
        ...conn,
        status:
          statusOf(evse.evseId, conn.connectorId) ?? (session != null ? 'occupied' : 'available'),
      })),
    }));
    // The session's energy goes on the first plugged connector, else on the first connector.
    const flat = withStatus.flatMap((e) => e.connectors);
    const carrier =
      session == null ? null : (flat.find((c) => c.status === 'occupied') ?? flat[0] ?? null);
    const evses = withStatus.map((evse) => ({
      ...evse,
      connectors: evse.connectors.map((conn) => ({
        ...conn,
        isPluggedIn: conn === carrier,
        energyDeliveredWh: conn === carrier && session != null ? session.energyWh : null,
      })),
    }));
    const statuses = evses.flatMap((e) => e.connectors.map((c) => c.status));
    const status = statuses.includes('faulted')
      ? 'faulted'
      : statuses.length > 0 && statuses.every((s) => s === 'unavailable')
        ? 'unavailable'
        : statuses.includes('reserved')
          ? 'reserved'
          : session != null || statuses.includes('occupied')
            ? 'charging'
            : 'available';
    power.set(station.id, {
      currentDrawKw: online ? powerAt(r.power, at) : 0,
      allocatedLimitKw: null,
    });
    return {
      ...station,
      status,
      statusReason: null,
      isOnline: online,
      inMaintenance: false,
      displayMessage: null,
      session: null,
      evses,
    };
  });
  return { stations: frame, power };
}

/** The local date (YYYY-MM-DD) of a time, for the day picker. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The moment of `minute` (0 to 1439) into a replayed day. */
export function replayMoment(day: Pick<ReplayDay, 'from' | 'to'>, minute: number): number {
  const from = Date.parse(day.from);
  const to = Date.parse(day.to);
  return Math.min(to, from + Math.round(minute) * 60_000);
}

/** The last minute of the day that has happened (`now` on today), else the end of the day. */
export function replayLastMinute(
  day: Pick<ReplayDay, 'from' | 'to'>,
  now: number = Date.now(),
): number {
  const from = Date.parse(day.from);
  const end = Math.min(Date.parse(day.to), now);
  // `to` is the next midnight (exclusive): the last minute of the day is 1439.
  return Math.min(1439, Math.max(0, Math.floor((end - from) / 60_000)));
}
