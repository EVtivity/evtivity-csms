// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {},
  drivers: {},
  tokenAuditLog: {},
  userFleetAssignments: {},
  users: {},
}));
vi.mock('../lib/user-management-scope.js', () => ({ visibleUserIds: vi.fn() }));

import { fleetCardHistoryEntries } from '../lib/fleet-card-history.js';
import type { ActorInfo, FleetCardAuditRow } from '../lib/fleet-card-history.js';

const FLEET = 'flt_000000000001';
const OTHER = 'flt_000000000002';

function row(over: Partial<FleetCardAuditRow>): FleetCardAuditRow {
  return {
    id: 1,
    action: 'updated',
    actor: 'operator',
    actorUserId: null,
    actorApiKeyId: null,
    before: null,
    after: null,
    notes: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    ...over,
  };
}

const snap = (over: Record<string, unknown>) => ({
  idToken: 'CARD-1',
  tokenType: 'ISO14443',
  driverId: null,
  label: null,
  fleetId: FLEET,
  ...over,
});

const members = new Map([
  ['drv_a', { id: 'drv_a', name: 'Anna Berg', erased: false }],
  ['drv_b', { id: 'drv_b', name: 'Ben Cole', erased: false }],
]);

describe('fleetCardHistoryEntries', () => {
  it('reads an added card given to a member', () => {
    const [entry] = fleetCardHistoryEntries(
      [row({ action: 'created', after: snap({ driverId: 'drv_a', label: 'Van 1' }) })],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['added', 'given']);
    expect(entry?.memberAfter).toEqual({ id: 'drv_a', name: 'Anna Berg', erased: false });
    expect(entry?.labelAfter).toBe('Van 1');
  });

  it('reads a card moved to another member and renamed', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          before: snap({ driverId: 'drv_a', label: 'Van 1' }),
          after: snap({ driverId: 'drv_b', label: 'Van 2' }),
        }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['given', 'renamed']);
    expect(entry?.memberBefore?.name).toBe('Anna Berg');
    expect(entry?.memberAfter?.name).toBe('Ben Cole');
    expect([entry?.labelBefore, entry?.labelAfter]).toEqual(['Van 1', 'Van 2']);
  });

  it('reads a changed monthly limit without its amounts', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          before: { ...snap({ label: 'Van 1' }), monthlyLimitCents: 10_000 },
          after: { ...snap({ label: 'Van 1' }), monthlyLimitCents: 25_000 },
        }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['limit_changed']);
    expect(JSON.stringify(entry)).not.toContain('25000');
  });

  it('marks a card taken back when the member left the fleet', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          actor: 'system',
          before: snap({ driverId: 'drv_a' }),
          after: snap({ driverId: null }),
          notes: 'Taken back when the member left the fleet',
        }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['taken_back']);
    expect(entry?.reason).toBe('member_left');
    expect(entry?.actor).toEqual({ kind: 'system', name: null, viaApiKey: false });
  });

  it('tells a suspension from a deactivation for good', () => {
    const entries = fleetCardHistoryEntries(
      [
        row({ id: 3, action: 'revoked', before: snap({}), after: snap({}) }),
        row({
          id: 2,
          action: 'deactivated',
          before: snap({}),
          after: snap({}),
          notes: 'Deactivated by an operator',
        }),
        row({ id: 1, action: 'deactivated', before: snap({}), after: snap({}) }),
        row({ id: 0, action: 'activated', before: snap({}), after: snap({}) }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entries.map((e) => e.changes)).toEqual([
      ['deactivated'],
      ['deactivated'],
      ['turned_off'],
      ['turned_on'],
    ]);
  });

  it('names no member or label from before the card joined the fleet', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          before: snap({ fleetId: null, driverId: 'drv_x', label: 'My own card' }),
          after: snap({ driverId: null, label: null }),
        }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['moved_into_fleet']);
    expect(entry?.memberBefore).toBeNull();
    expect(entry?.labelBefore).toBeNull();
  });

  it('names no member or label from after the card left the fleet', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          before: snap({ driverId: null, label: 'Van 1' }),
          after: snap({ fleetId: OTHER, driverId: 'drv_z', label: 'Other fleet' }),
        }),
      ],
      FLEET,
      new Map(),
      members,
    );
    expect(entry?.changes).toEqual(['moved_out_of_fleet']);
    expect(entry?.memberAfter).toBeNull();
    expect(entry?.labelAfter).toBeNull();
  });

  it('never carries the card value or type, and names no actor without a name', () => {
    const actors = new Map<string, ActorInfo>([
      ['usr_fleet', { kind: 'fleet_user', name: 'Fay Fleet' }],
      ['usr_op', { kind: 'operator', name: null }],
    ]);
    const entries = fleetCardHistoryEntries(
      [
        row({
          id: 2,
          actor: 'api_key',
          actorUserId: 'usr_fleet',
          actorApiKeyId: '7',
          before: snap({ label: null }),
          after: snap({ label: 'Van 9' }),
        }),
        row({
          id: 1,
          actorUserId: 'usr_op',
          before: snap({ idToken: 'OLD-VALUE' }),
          after: snap({ idToken: 'NEW-VALUE' }),
        }),
      ],
      FLEET,
      actors,
      members,
    );
    expect(entries[0]?.actor).toEqual({ kind: 'fleet_user', name: 'Fay Fleet', viaApiKey: true });
    expect(entries[1]?.actor).toEqual({ kind: 'operator', name: null, viaApiKey: false });
    expect(entries[1]?.changes).toEqual(['changed']);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('VALUE');
    expect(text).not.toContain('CARD-1');
    expect(text).not.toContain('ISO14443');
  });

  it('reads an unknown actor user as an unnamed operator and an erased member without a name', () => {
    const [entry] = fleetCardHistoryEntries(
      [
        row({
          actorUserId: 'usr_gone',
          before: snap({ driverId: 'drv_e' }),
          after: snap({ driverId: null }),
        }),
      ],
      FLEET,
      new Map(),
      new Map([['drv_e', { id: 'drv_e', name: null, erased: true }]]),
    );
    expect(entry?.actor).toEqual({ kind: 'operator', name: null, viaApiKey: false });
    expect(entry?.memberBefore).toEqual({ id: 'drv_e', name: null, erased: true });
  });
});
