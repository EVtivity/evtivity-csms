// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// State of charge predictions from the site plan: when the minimum target is
// reached, the SoC the plan ends at (capped at the maximum target) and when,
// and what the battery holds at the departure. Linear inside each 15-minute
// slot, so a prediction is not rounded to a slot.

import type { PredictionSnapshot } from './information.js';

export interface SocPredictionInput {
  nowMs: number;
  /** The fresh SoC, else the expected SoC at arrival, else null. */
  socPercent: number | null;
  capacityKwh: number | null;
  /** Slot windows of the plan and the planned battery power per slot (kW). */
  slots: ReadonlyArray<{ startMs: number; endMs: number }>;
  powerKw: readonly number[];
  minSocPercent: number;
  maxSocPercent: number;
  /** Null for an ad hoc request. */
  departureMs: number | null;
}

const HOUR_MS = 3_600_000;
const EPS = 1e-9;

interface Segment {
  startMs: number;
  endMs: number;
  fromSoc: number;
  perMs: number;
}

function segments(input: SocPredictionInput, capacity: number, startSoc: number): Segment[] {
  const out: Segment[] = [];
  let soc = startSoc;
  input.slots.forEach((slot, s) => {
    const kw = input.powerKw[s] ?? 0;
    const start = Math.max(slot.startMs, input.nowMs);
    const end = input.departureMs != null ? Math.min(slot.endMs, input.departureMs) : slot.endMs;
    if (end <= start || !(kw > EPS)) return;
    const perMs = ((kw / capacity) * 100) / HOUR_MS;
    out.push({ startMs: start, endMs: end, fromSoc: soc, perMs });
    soc = Math.min(100, soc + perMs * (end - start));
  });
  return out;
}

/** When the SoC first reaches `level`, or null when the plan never gets there. */
function reachedAt(
  segs: readonly Segment[],
  startSoc: number,
  nowMs: number,
  level: number,
): number | null {
  if (startSoc >= level - EPS) return nowMs;
  for (const seg of segs) {
    const endSoc = seg.fromSoc + seg.perMs * (seg.endMs - seg.startMs);
    if (endSoc >= level - EPS) return seg.startMs + (level - seg.fromSoc) / seg.perMs;
  }
  return null;
}

/**
 * Null fields mean unknown (no SoC or no capacity) or not reached within the
 * plan. A battery already at a target reaches it now.
 */
export function predictSocTimeline(input: SocPredictionInput): PredictionSnapshot {
  const departureAt = input.departureMs != null ? new Date(input.departureMs) : null;
  const capacity = input.capacityKwh;
  if (input.socPercent == null || capacity == null || !(capacity > 0)) {
    return {
      minSocPercent: input.minSocPercent,
      minReachedAt: null,
      finalSocPercent: null,
      finalReachedAt: null,
      departureAt,
      socAtDeparture: null,
    };
  }
  const startSoc = Math.min(100, Math.max(0, input.socPercent));
  const segs = segments(input, capacity, startSoc);
  const last = segs[segs.length - 1];
  const endSoc =
    last != null
      ? Math.min(100, last.fromSoc + last.perMs * (last.endMs - last.startMs))
      : startSoc;
  const finalSoc = Math.min(endSoc, Math.max(startSoc, input.maxSocPercent));
  const minAt = reachedAt(segs, startSoc, input.nowMs, input.minSocPercent);
  const finalAt = reachedAt(segs, startSoc, input.nowMs, finalSoc);
  return {
    minSocPercent: input.minSocPercent,
    minReachedAt: minAt != null ? new Date(Math.round(minAt)) : null,
    finalSocPercent: finalSoc,
    finalReachedAt: finalAt != null ? new Date(Math.round(finalAt)) : null,
    departureAt,
    socAtDeparture: departureAt != null ? endSoc : null,
  };
}
