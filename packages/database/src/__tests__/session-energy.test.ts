// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
  applyRegisterReading,
  applySessionEnergyReading,
  registerStateFromRow,
} from '../lib/session-energy.js';
import type { SessionRegisterState } from '../lib/session-energy.js';

const t = (iso: string): Date => new Date(`2026-06-04T${iso}Z`);

const state = (overrides: Partial<SessionRegisterState> = {}): SessionRegisterState => ({
  meterStartWh: 100_000,
  offsetWh: 0,
  lastRegisterWh: 110_000,
  lastRegisterAt: t('01:00:00'),
  energyWh: 10_000,
  ...overrides,
});

describe('applyRegisterReading (B10)', () => {
  it('sets meter_start from the first reading of a 2.1 transaction', () => {
    const first = applyRegisterReading(
      {
        meterStartWh: null,
        offsetWh: 0,
        lastRegisterWh: null,
        lastRegisterAt: null,
        energyWh: null,
      },
      { registerWh: 5_000.4, at: t('00:00:00') },
    );
    expect(first).toMatchObject({
      kind: 'first',
      meterStartWh: 5_000,
      offsetWh: 0,
      lastRegisterWh: 5_000.4,
      lastRegisterAt: t('00:00:00'),
    });
    expect(first.energyWh).toBeCloseTo(0.4, 6);
  });

  it('adds a newer, higher reading to the energy', () => {
    expect(applyRegisterReading(state(), { registerWh: 112_500, at: t('01:01:00') })).toMatchObject(
      {
        kind: 'advance',
        energyWh: 12_500,
        lastRegisterWh: 112_500,
        lastRegisterAt: t('01:01:00'),
      },
    );
  });

  it('never lowers the energy from a reading older than the newest projected one', () => {
    const result = applyRegisterReading(state(), { registerWh: 105_000, at: t('00:30:00') });
    expect(result).toMatchObject({
      kind: 'stale',
      energyWh: 10_000,
      lastRegisterWh: 110_000,
      lastRegisterAt: t('01:00:00'),
    });
    // An older reading that is higher is also already counted by the newer one.
    expect(applyRegisterReading(state(), { registerWh: 120_000, at: t('00:59:59') }).energyWh).toBe(
      10_000,
    );
  });

  it('rebases on a register drop (meter reset or replacement) and keeps counting from it', () => {
    const reset = applyRegisterReading(state(), { registerWh: 0, at: t('01:01:00') });
    expect(reset).toMatchObject({
      kind: 'drop',
      offsetWh: 110_000,
      lastRegisterWh: 0,
      energyWh: 10_000,
    });
    const after = applyRegisterReading(
      { ...state(), ...reset, energyWh: reset.energyWh },
      { registerWh: 2_000, at: t('01:02:00') },
    );
    expect(after).toMatchObject({ kind: 'advance', offsetWh: 110_000, energyWh: 12_000 });
  });

  it('treats a first reading below meter_start as a drop and bills nothing for it', () => {
    expect(
      applyRegisterReading(state({ lastRegisterWh: null, lastRegisterAt: null, energyWh: null }), {
        registerWh: 40,
        at: t('00:01:00'),
      }),
    ).toMatchObject({ kind: 'drop', offsetWh: 99_960, energyWh: 0 });
  });

  it('accepts several readings with the same timestamp (J02.FR.14)', () => {
    expect(applyRegisterReading(state(), { registerWh: 110_000, at: t('01:00:00') })).toMatchObject(
      { kind: 'advance', energyWh: 10_000 },
    );
  });

  it('is idempotent: rerunning the stored reading changes nothing', () => {
    const first = applyRegisterReading(state(), { registerWh: 50, at: t('01:05:00') });
    const rerun = applyRegisterReading(
      { ...first, energyWh: first.energyWh },
      { registerWh: 50, at: t('01:05:00') },
    );
    expect(rerun).toMatchObject({ offsetWh: first.offsetWh, energyWh: first.energyWh });
  });
});

describe('registerStateFromRow', () => {
  it('reads the numeric columns and the timestamp', () => {
    expect(
      registerStateFromRow({
        meter_start: 100,
        meter_register_offset_wh: '25',
        meter_last_register_wh: '300',
        meter_last_register_at: '2026-06-04T01:00:00Z',
        energy_delivered_wh: '225',
      }),
    ).toEqual({
      meterStartWh: 100,
      offsetWh: 25,
      lastRegisterWh: 300,
      lastRegisterAt: t('01:00:00'),
      energyWh: 225,
    });
    expect(registerStateFromRow({})).toEqual({
      meterStartWh: null,
      offsetWh: 0,
      lastRegisterWh: null,
      lastRegisterAt: null,
      energyWh: null,
    });
  });
});

function makeSql(row: Record<string, unknown> | null): {
  sql: postgres.Sql;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(text.includes('FOR UPDATE') && row != null ? [row] : []);
  };
  (fn as unknown as Record<string, unknown>)['begin'] = vi.fn(
    (cb: (tx: unknown) => Promise<unknown>) => cb(fn),
  );
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('applySessionEnergyReading', () => {
  const row = {
    meter_start: 100_000,
    meter_register_offset_wh: '0',
    meter_last_register_wh: '110000',
    meter_last_register_at: '2026-06-04T01:00:00Z',
    energy_delivered_wh: '10000',
  };

  it('stores the energy, the offset and the newest register under the row lock', async () => {
    const { sql, calls } = makeSql(row);
    const result = await applySessionEnergyReading(sql, {
      sessionId: 'ses_1',
      registerWh: 111_000,
      at: t('01:01:00'),
    });
    expect(result).toMatchObject({ kind: 'advance', energyWh: 11_000, previousEnergyWh: 10_000 });
    expect(calls[0]?.text).toContain("status = 'active'");
    expect(calls[0]?.text).toContain('FOR UPDATE');
    expect(calls[1]?.text).toContain('UPDATE charging_sessions');
    expect(calls[1]?.values.slice(0, 5)).toEqual([
      100_000,
      0,
      111_000,
      '2026-06-04T01:01:00.000Z',
      11_000,
    ]);
    // Raised by 1 Wh or more: energy_rose_at moves to the reading.
    expect(calls[1]?.values[5]).toBe(true);
  });

  it('writes nothing for a stale reading', async () => {
    const { sql, calls } = makeSql(row);
    const result = await applySessionEnergyReading(sql, {
      sessionId: 'ses_1',
      registerWh: 90_000,
      at: t('00:30:00'),
    });
    expect(result?.kind).toBe('stale');
    expect(calls).toHaveLength(1);
  });

  it('returns null for a session that is not active', async () => {
    const { sql } = makeSql(null);
    expect(
      await applySessionEnergyReading(sql, {
        sessionId: 'ses_1',
        registerWh: 1,
        at: t('01:00:00'),
      }),
    ).toBeNull();
  });
});
