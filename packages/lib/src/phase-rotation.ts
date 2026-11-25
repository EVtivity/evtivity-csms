// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EV_PHASES } from './ev-phases.js';
import type { EvPhases } from './ev-phases.js';

/**
 * The six wirings of a three-phase component to its parent (OCPP 2.x
 * PhaseRotation, OCPP 1.6 ConnectorPhaseRotation): letter n names the parent
 * phase the component's phase n is wired to, R for L1, S for L2, T for L3.
 */
export const PHASE_ROTATIONS = ['RST', 'RTS', 'SRT', 'STR', 'TRS', 'TSR'] as const;
export type PhaseRotation = (typeof PHASE_ROTATIONS)[number];

const LETTER_PHASE: Record<string, 'L1' | 'L2' | 'L3'> = { R: 'L1', S: 'L2', T: 'L3' };

export function isPhaseRotation(value: unknown): value is PhaseRotation {
  return typeof value === 'string' && (PHASE_ROTATIONS as readonly string[]).includes(value);
}

/**
 * A reported PhaseRotation value as a rotation, or null when it tells
 * nothing: empty, Unknown, NotApplicable, a phase not connected (x) or any
 * other text.
 */
export function parsePhaseRotation(value: string | null | undefined): PhaseRotation | null {
  const trimmed = value?.trim().toUpperCase() ?? '';
  return isPhaseRotation(trimmed) ? trimmed : null;
}

/**
 * The OCPP 1.6 ConnectorPhaseRotation list (`0.RST, 1.RST, 2.RTS`) by
 * connector id; entries that tell no rotation are left out.
 */
export function parseConnectorPhaseRotations(
  csl: string | null | undefined,
): Map<number, PhaseRotation> {
  const result = new Map<number, PhaseRotation>();
  for (const item of (csl ?? '').split(',')) {
    const match = /^\s*(\d+)\.(.+)$/.exec(item);
    if (match == null) continue;
    const rotation = parsePhaseRotation(match[2]);
    if (rotation != null) result.set(Number(match[1]), rotation);
  }
  return result;
}

/**
 * The parent phase a single-phase component's one phase is wired to: the
 * first letter of its PhaseRotation (`Sxx` or `STR`: on L2), null when it
 * tells nothing (x, empty, Unknown, NotApplicable).
 */
export function singlePhaseOfRotation(value: string | null | undefined): 'L1' | 'L2' | 'L3' | null {
  const text = value?.trim() ?? '';
  if (!/^[RSTx]{3}$/i.test(text)) return null;
  return LETTER_PHASE[(text[0] ?? '').toUpperCase()] ?? null;
}

/** The component phase (1 to 3) wired to `parentPhase` through `rotation`; null when none is. */
export function componentPhaseOn(
  rotation: PhaseRotation,
  parentPhase: 'L1' | 'L2' | 'L3',
): 1 | 2 | 3 | null {
  const index = rotation.split('').findIndex((letter) => LETTER_PHASE[letter] === parentPhase);
  return index === 0 ? 1 : index === 1 ? 2 : index === 2 ? 3 : null;
}

/** The phases of a component as phases of its parent through its rotation. */
export function phasesThroughRotation(phases: EvPhases, rotation: PhaseRotation): EvPhases {
  const lines = new Set<string>();
  for (const index of [1, 2, 3]) {
    if (!phases.includes(`L${String(index)}`)) continue;
    const mapped = LETTER_PHASE[rotation[index - 1] ?? ''];
    if (mapped != null) lines.add(mapped);
  }
  const name = [...lines].sort().join('');
  return (EV_PHASES as readonly string[]).includes(name) ? (name as EvPhases) : phases;
}
