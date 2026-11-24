// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const EV_PHASES = ['L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3', 'L1L2L3'] as const;
export type EvPhases = (typeof EV_PHASES)[number];

/** A phase carries the session when its latest Current.Import is at least this, A. */
export const PHASE_CURRENT_THRESHOLD_A = 1;

export interface PhaseCurrentReading {
  /** The OCPP phase of the sample: L1, L2, L3 or L1-N, L2-N, L3-N. */
  phase: string;
  amps: number;
}

const LINE = /^L([123])(?:-N)?$/;

/**
 * The phases a session charges on: the lines whose Current.Import reading is at
 * least 1 A, else all three when the station reports numberOfPhasesUsed 3.
 * Null when neither tells (a single-phase EV without per-phase readings): the
 * session then counts on every phase of its circuit.
 */
export function phasesFromReadings(
  readings: readonly PhaseCurrentReading[],
  numberOfPhasesUsed: number | null,
): EvPhases | null {
  const lines = new Set<string>();
  for (const r of readings) {
    const line = LINE.exec(r.phase)?.[1];
    if (line != null && Number.isFinite(r.amps) && r.amps >= PHASE_CURRENT_THRESHOLD_A) {
      lines.add(line);
    }
  }
  if (lines.size > 0) {
    const name = [...lines]
      .sort()
      .map((l) => `L${l}`)
      .join('');
    return (EV_PHASES as readonly string[]).includes(name) ? (name as EvPhases) : null;
  }
  return numberOfPhasesUsed === 3 ? 'L1L2L3' : null;
}

/** How many phases a stored phase set names, null for unknown. */
export function phaseCountOf(phases: string | null): number | null {
  if (phases == null || !(EV_PHASES as readonly string[]).includes(phases)) return null;
  return phases.length / 2;
}
