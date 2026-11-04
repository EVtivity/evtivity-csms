// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DepartureReadiness, DepartureReadinessReason } from '@evtivity/lib/charging-plan';
import { DEPARTURE_READINESS_REASONS, DEPARTURE_READINESS_STATES } from '../schema/departures.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const migration = readFileSync(
  resolve(import.meta.dirname, '../migrations/0486_release_0_1_50.sql'),
  'utf-8',
);

function checkValues(name: string): string[] {
  const match = new RegExp(`"${name}" CHECK \\(([^\\n]*)\\)`).exec(migration);
  expect(match, name).not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('vehicle departure readiness lists', () => {
  it('hold every state and reason the planner writes, and nothing else', () => {
    const states: Same<(typeof DEPARTURE_READINESS_STATES)[number], DepartureReadiness> = true;
    const reasons: Same<(typeof DEPARTURE_READINESS_REASONS)[number], DepartureReadinessReason> =
      true;
    expect(states).toBe(true);
    expect(reasons).toBe(true);
  });

  it('match the CHECKs of the migration', () => {
    expect(checkValues('vdp_readiness_check').sort()).toEqual(
      [...DEPARTURE_READINESS_STATES].sort(),
    );
    expect(checkValues('vdp_readiness_reason_check').sort()).toEqual(
      [...DEPARTURE_READINESS_REASONS].sort(),
    );
  });
});
