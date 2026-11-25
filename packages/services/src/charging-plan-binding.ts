// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import { type PlanDepartureRow, type PlanSessionRow } from '@evtivity/database';
import { HORIZON_MS } from './charging-plan-nodes.js';

export interface DepartureBinding {
  /** Departure id to the active session charging for it. */
  sessions: Map<string, PlanSessionRow>;
  /** Bindings to store (`vehicle_departures.session_id`); null unbinds. */
  writes: Array<{ departureId: string; sessionId: string | null }>;
}

/**
 * Binds departures to active sessions: a departure keeps an active session it
 * is bound to while that session still charges the departure's vehicle, and is
 * unbound when the session's vehicle changed; a session whose vehicle has a
 * scheduled departure at the site
 * within the planner horizon binds to the earliest one. `departures` are in
 * departure order.
 */
export function bindDepartures(
  departures: readonly PlanDepartureRow[],
  sessions: readonly PlanSessionRow[],
  nowMs: number,
): DepartureBinding {
  const active = new Map(sessions.map((s) => [s.id, s]));
  const bound = new Map<string, PlanSessionRow>();
  const taken = new Set<string>();
  const writes: DepartureBinding['writes'] = [];
  // An ad hoc departure (no time) never departs: it lasts until its session ends.
  const departureMs = (d: PlanDepartureRow): number =>
    d.departureAt != null ? d.departureAt.getTime() : Number.POSITIVE_INFINITY;
  for (const d of departures) {
    if (d.sessionId == null) continue;
    if (d.held === true) {
      // A terminated request keeps its session, whatever its vehicle, at zero
      // power; the binding is not written (the row is cancelled).
      const held = active.get(d.sessionId);
      if (held != null && !taken.has(held.id)) {
        bound.set(d.id, held);
        taken.add(held.id);
      }
      continue;
    }
    if (departureMs(d) <= nowMs) continue;
    const session = active.get(d.sessionId);
    if (session == null) continue;
    if (session.vehicleId !== d.vehicleId || taken.has(session.id)) {
      writes.push({ departureId: d.id, sessionId: null });
      continue;
    }
    bound.set(d.id, session);
    taken.add(session.id);
  }
  for (const session of sessions) {
    if (session.vehicleId == null || taken.has(session.id)) continue;
    const departure = departures.find((d) => {
      const at = departureMs(d);
      return (
        d.held !== true &&
        d.vehicleId === session.vehicleId &&
        !bound.has(d.id) &&
        at > nowMs &&
        (d.departureAt == null || at <= nowMs + HORIZON_MS)
      );
    });
    if (departure == null) continue;
    bound.set(departure.id, session);
    taken.add(session.id);
    writes.push({ departureId: departure.id, sessionId: session.id });
  }
  return { sessions: bound, writes };
}
