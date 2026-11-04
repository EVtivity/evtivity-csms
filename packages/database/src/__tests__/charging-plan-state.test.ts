// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  mergeLockedPlanEntries,
  patchSitePlanEntries,
  recordChargingPlanProfileReply,
  writeSitePlan,
  type DepartureDb,
} from '../lib/vehicle-departures.js';

interface Fake {
  tx: DepartureDb;
  sets: Array<Record<string, unknown>>;
}

function fakeTx(plan: unknown, siteId = 'sit_a'): Fake {
  const sets: Array<Record<string, unknown>> = [];
  const t = {
    select: () => ({
      from: () => ({
        where: () => ({ for: () => Promise.resolve(plan === undefined ? [] : [{ plan }]) }),
      }),
    }),
    execute: () => Promise.resolve(plan === undefined ? [] : [{ site_id: siteId, plan }]),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  const tx = {
    transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(t),
  } as unknown as DepartureDb;
  return { tx, sets };
}

const entry = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  departureId: `vdp_${sessionId}`,
  sessionId,
  stationDbId: 'sta_a',
  powerKw: [10],
  ...extra,
});

describe('patchSitePlanEntries', () => {
  it('merges fields into the named entries and removes null ones', async () => {
    const fake = fakeTx([entry('ses_1', { measure: { lowCycles: 2 } }), entry('ses_2')]);
    const changed = await patchSitePlanEntries(
      'sit_a',
      [{ sessionId: 'ses_1', patch: { profile: { id: 7, state: 'sent' }, measure: null } }],
      fake.tx,
    );
    expect(changed).toBe(1);
    expect(fake.sets[0]?.['plan']).toEqual([
      entry('ses_1', { profile: { id: 7, state: 'sent' } }),
      entry('ses_2'),
    ]);
  });

  it('writes nothing for a session the plan no longer lists, or without a plan', async () => {
    const fake = fakeTx([entry('ses_2')]);
    expect(
      await patchSitePlanEntries('sit_a', [{ sessionId: 'ses_1', patch: { x: 1 } }], fake.tx),
    ).toBe(0);
    expect(fake.sets).toEqual([]);
    expect(
      await patchSitePlanEntries(
        'sit_a',
        [{ sessionId: 'ses_1', patch: { x: 1 } }],
        fakeTx(undefined).tx,
      ),
    ).toBe(0);
  });
});

describe('recordChargingPlanProfileReply', () => {
  const at = new Date('2026-11-02T01:05:00Z');
  const sent = (state = 'sent', extra: Record<string, unknown> = {}) => [
    entry('ses_1', { profile: { id: 7, hash: 'h', slotStartMs: 0, state, sentAt: 'x', ...extra } }),
  ];
  const profileOf = (fake: Fake) =>
    (fake.sets[0]?.['plan'] as Array<{ profile: Record<string, unknown> }>)[0]?.profile;

  it('marks a refused profile rejected with its time and the refused unit', async () => {
    const fake = fakeTx(sent());
    expect(
      await recordChargingPlanProfileReply(
        'sta_a',
        7,
        'rejected',
        at,
        { rejectedUnit: 'W' },
        fake.tx,
      ),
    ).toEqual({ siteId: 'sit_a', changed: true, stale: false });
    expect(profileOf(fake)).toMatchObject({
      state: 'rejected',
      rejectedAt: at.toISOString(),
      repliedAt: at.toISOString(),
      rejectedUnits: ['W'],
    });
  });

  it('adds a second refused unit to a profile already rejected', async () => {
    const fake = fakeTx(sent('rejected', { rejectedUnits: ['W'] }));
    const result = await recordChargingPlanProfileReply(
      'sta_a',
      7,
      'rejected',
      at,
      { rejectedUnit: 'A' },
      fake.tx,
    );
    expect(result?.changed).toBe(true);
    expect(profileOf(fake)?.['rejectedUnits']).toEqual(['W', 'A']);
  });

  it('records no answer as not sent, never as a refusal', async () => {
    const fake = fakeTx(sent());
    await recordChargingPlanProfileReply('sta_a', 7, 'not_sent', at, {}, fake.tx);
    expect(profileOf(fake)).toMatchObject({ state: 'not_sent', repliedAt: at.toISOString() });
    expect(profileOf(fake)?.['rejectedAt']).toBeUndefined();
  });

  it('ignores a reply to an older profile with another hash', async () => {
    const fake = fakeTx(sent());
    expect(
      await recordChargingPlanProfileReply('sta_a', 7, 'rejected', at, { hash: 'old' }, fake.tx),
    ).toEqual({ siteId: 'sit_a', changed: false, stale: true });
    expect(fake.sets).toEqual([]);
    const matching = fakeTx(sent());
    await recordChargingPlanProfileReply('sta_a', 7, 'accepted', at, { hash: 'h' }, matching.tx);
    expect(profileOf(matching)?.['state']).toBe('accepted');
  });

  it('writes nothing for the same answer again', async () => {
    const fake = fakeTx(sent('accepted'));
    expect(await recordChargingPlanProfileReply('sta_a', 7, 'accepted', at, {}, fake.tx)).toEqual({
      siteId: 'sit_a',
      changed: false,
      stale: false,
    });
    expect(fake.sets).toEqual([]);
  });

  it('ignores a profile no plan entry sent', async () => {
    expect(
      await recordChargingPlanProfileReply('sta_a', 8, 'rejected', at, {}, fakeTx(sent()).tx),
    ).toBeNull();
    expect(
      await recordChargingPlanProfileReply('sta_b', 7, 'rejected', at, {}, fakeTx(sent()).tx),
    ).toBeNull();
    expect(
      await recordChargingPlanProfileReply('sta_a', 7, 'rejected', at, {}, fakeTx(undefined).tx),
    ).toBeNull();
  });
});

describe('mergeLockedPlanEntries', () => {
  const profile = (state: string) => ({ id: 7, hash: 'h', slotStartMs: 0, state, sentAt: 'x' });

  it('takes each profile from the locked row, so a reply stored meanwhile survives', () => {
    const merged = mergeLockedPlanEntries(
      [entry('ses_1', { profile: profile('sent'), powerKw: [5] })],
      [entry('ses_1', { profile: profile('rejected') })],
    ) as Array<Record<string, unknown>>;
    expect(merged).toEqual([entry('ses_1', { profile: profile('rejected'), powerKw: [5] })]);
  });

  it('drops a profile the locked row no longer holds (a failed send put it back)', () => {
    const merged = mergeLockedPlanEntries(
      [entry('ses_1', { profile: profile('sent') })],
      [entry('ses_1')],
    );
    expect(merged).toEqual([entry('ses_1')]);
  });

  it('keeps the new measurement, else the locked one', () => {
    const fresh = { limitKw: 5 };
    const stored = { limitKw: 9 };
    expect(
      mergeLockedPlanEntries(
        [entry('ses_1', { measure: fresh }), entry('ses_2')],
        [entry('ses_1', { measure: stored }), entry('ses_2', { measure: stored })],
      ),
    ).toEqual([entry('ses_1', { measure: fresh }), entry('ses_2', { measure: stored })]);
  });

  it('keeps a session that left the plan as a left entry until its profile is cleared', () => {
    const merged = mergeLockedPlanEntries(
      [entry('ses_2')],
      [
        entry('ses_1', { profile: profile('accepted') }),
        entry('ses_3', { profile: profile('cleared'), left: true }),
        entry('ses_4'),
      ],
    );
    expect(merged).toEqual([
      entry('ses_2'),
      entry('ses_1', { profile: profile('accepted'), left: true }),
    ]);
  });

  it('plans a left session again with its profile state', () => {
    expect(
      mergeLockedPlanEntries(
        [entry('ses_1')],
        [entry('ses_1', { profile: profile('cleared'), left: true })],
      ),
    ).toEqual([entry('ses_1', { profile: profile('cleared') })]);
  });
});

describe('writeSitePlan', () => {
  it('merges the plan with the row it locks before writing', async () => {
    const locked = [entry('ses_1', { profile: { id: 7, state: 'rejected' } })];
    const inserted: Array<Record<string, unknown>> = [];
    const t = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([{ plan: locked }]) }) }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { onConflictDoUpdate: () => Promise.resolve() };
        },
      }),
      execute: () => Promise.resolve([]),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
    };
    const tx = {
      transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(t),
    } as unknown as DepartureDb;
    await writeSitePlan(
      'sit_a',
      {
        staleAtRead: null,
        trigger: 'slot_boundary',
        slotStarts: [],
        plan: [entry('ses_1', { profile: { id: 7, state: 'sent' } })],
        siteLoadKw: [],
        capacityKw: [],
        pricePerKwh: [],
        runtimeMs: 1,
      },
      [],
      tx,
    );
    expect(inserted[0]?.['plan']).toEqual(locked);
  });
});
