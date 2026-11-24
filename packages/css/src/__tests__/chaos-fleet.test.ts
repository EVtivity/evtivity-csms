// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import {
  FLEET_REFUSAL_BACKOFF_MAX_MS,
  FLEET_REFUSAL_BACKOFF_MS,
  FLEET_SESSION_SHARE,
  FLEET_START_RESULT_TTL_MS,
  FleetCharging,
  fleetOfToken,
  isAuthorizationRefusal,
  tokenFitsProtocol,
  type FleetToken,
  type FleetTokenRow,
} from '../chaos-fleet.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');

function row(partial: Partial<FleetTokenRow> = {}): FleetTokenRow {
  return {
    id_token: 'NWPOOLCARD01',
    token_type: 'ISO14443',
    is_active: true,
    revoked_at: null,
    expires_at: null,
    prepaid_balance_cents: null,
    card_fleet_id: 'flt_demoacct0001',
    card_fleet_bills: true,
    member_fleet_id: null,
    driver_id: null,
    driver_active: null,
    driver_erased_at: null,
    driver_email: null,
    depot_only: false,
    ...partial,
  };
}

const memberToken = {
  card_fleet_id: null,
  card_fleet_bills: false,
  member_fleet_id: 'flt_member0001',
  driver_id: 'drv_1',
  driver_active: true,
  driver_email: 'lena@example.com',
};

// A seeded linear congruential source, so every run draws the same numbers.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const card = (idToken: string, fleetId = 'flt_demoacct0001'): FleetToken => ({
  idToken,
  tokenType: 'ISO14443',
  fleetId,
});

describe('fleetOfToken', () => {
  it('bills an unheld fleet card to its fleet', () => {
    expect(fleetOfToken(row(), true, NOW)).toBe('flt_demoacct0001');
  });

  it('bills a fleet card a member holds to the card fleet, not the member fleet', () => {
    expect(
      fleetOfToken(
        row({ driver_id: 'drv_1', driver_active: true, member_fleet_id: 'flt_other' }),
        true,
        NOW,
      ),
    ).toBe('flt_demoacct0001');
  });

  it('bills a member token to the member fleet', () => {
    expect(fleetOfToken(row(memberToken), true, NOW)).toBe('flt_member0001');
  });

  it.each<[string, Partial<FleetTokenRow>]>([
    ['an inactive card', { is_active: false }],
    ['a revoked card', { revoked_at: '2026-11-01T00:00:00Z' }],
    ['an expired card', { expires_at: new Date(NOW - 1) }],
    ['a prepaid card', { prepaid_balance_cents: 500 }],
    ['a card its fleet cannot bill', { card_fleet_bills: false }],
    ['a card of an inactive driver', { driver_id: 'drv_1', driver_active: false }],
    [
      'a card of an erased driver',
      { driver_id: 'drv_1', driver_active: true, driver_erased_at: '2026-11-02T00:00:00Z' },
    ],
    [
      'a card of the OCTT driver',
      { driver_id: 'drv_1', driver_active: true, driver_email: OCTT_TEST_DRIVER_EMAIL },
    ],
    ['a card of a vehicle that charges at the depot only', { depot_only: true }],
    ['a member token without an account billing fleet', { ...memberToken, member_fleet_id: null }],
  ])('never uses %s', (_label, partial) => {
    expect(fleetOfToken(row(partial), true, NOW)).toBeNull();
  });

  it('keeps a card that expires later', () => {
    expect(fleetOfToken(row({ expires_at: new Date(NOW + 60_000) }), true, NOW)).toBe(
      'flt_demoacct0001',
    );
  });

  it('uses no fleet token while Fleets is off', () => {
    expect(fleetOfToken(row(), false, NOW)).toBeNull();
    expect(fleetOfToken(row(memberToken), false, NOW)).toBeNull();
  });
});

describe('tokenFitsProtocol', () => {
  it('fits a 1.6 idTag of at most 20 characters', () => {
    expect(tokenFitsProtocol(card('A'.repeat(20)), 'ocpp1.6')).toBe(true);
    expect(tokenFitsProtocol(card('A'.repeat(21)), 'ocpp1.6')).toBe(false);
  });

  it('fits a 2.0.1 IdToken of at most 36 characters and any length on 2.1', () => {
    expect(tokenFitsProtocol(card('A'.repeat(36)), 'ocpp2.0.1')).toBe(true);
    expect(tokenFitsProtocol(card('A'.repeat(37)), 'ocpp2.0.1')).toBe(false);
    expect(tokenFitsProtocol(card('A'.repeat(37)), 'ocpp2.1')).toBe(true);
  });

  it('presents card types only, never a contract or vehicle id', () => {
    for (const tokenType of ['eMAID', 'MacAddress', 'VIN', 'NoAuthorization', 'DirectPayment']) {
      expect(tokenFitsProtocol({ ...card('X1'), tokenType }, 'ocpp2.1')).toBe(false);
    }
  });
});

describe('FleetCharging.pick', () => {
  it('draws nothing and starts with the public pool while the pool is empty', () => {
    let draws = 0;
    const fleet = new FleetCharging(() => {
      draws++;
      return 0;
    });
    expect(fleet.pick('ocpp2.1', new Set(), NOW)).toBeNull();
    expect(draws).toBe(0);
  });

  it('gives about one start in eight a fleet token with a seeded source', () => {
    const fleet = new FleetCharging(seeded(7));
    fleet.setTokens([card('C1'), card('C2'), card('C3')]);
    const starts = 4000;
    let fleetStarts = 0;
    for (let i = 0; i < starts; i++) {
      if (fleet.pick('ocpp2.1', new Set(), NOW) != null) fleetStarts++;
    }
    expect(fleetStarts / starts).toBeCloseTo(FLEET_SESSION_SHARE, 1);
  });

  it('skips a card charging elsewhere and falls back to the public pool when none is free', () => {
    const fleet = new FleetCharging(() => 0);
    fleet.setTokens([card('C1'), card('C2')]);
    expect(fleet.pick('ocpp2.1', new Set(['C1']), NOW)?.idToken).toBe('C2');
    expect(fleet.pick('ocpp2.1', new Set(['C1', 'C2']), NOW)).toBeNull();
  });
});

describe('FleetCharging back-off', () => {
  const refuse = (fleet: FleetCharging, commandId: string, at: number): string | null => {
    fleet.trackStart(commandId, 'C1', at);
    return fleet.onResult(
      { commandId, success: false, error: 'Authorization rejected: Blocked' },
      at,
    );
  };

  it('parks a refused card for the base, doubling on each refusal in a row up to the cap', () => {
    const fleet = new FleetCharging(() => 0);
    fleet.setTokens([card('C1')]);

    expect(refuse(fleet, 'cmd-1', NOW)).toBe('C1');
    expect(fleet.pick('ocpp2.1', new Set(), NOW)).toBeNull();
    expect(fleet.isBackedOff('C1', NOW + FLEET_REFUSAL_BACKOFF_MS - 1)).toBe(true);
    expect(fleet.isBackedOff('C1', NOW + FLEET_REFUSAL_BACKOFF_MS)).toBe(false);

    let at = NOW + FLEET_REFUSAL_BACKOFF_MS;
    refuse(fleet, 'cmd-2', at);
    expect(fleet.isBackedOff('C1', at + 2 * FLEET_REFUSAL_BACKOFF_MS - 1)).toBe(true);
    expect(fleet.isBackedOff('C1', at + 2 * FLEET_REFUSAL_BACKOFF_MS)).toBe(false);

    for (let i = 3; i <= 10; i++) {
      at += FLEET_REFUSAL_BACKOFF_MAX_MS;
      refuse(fleet, `cmd-${String(i)}`, at);
    }
    expect(fleet.isBackedOff('C1', at + FLEET_REFUSAL_BACKOFF_MAX_MS - 1)).toBe(true);
    expect(fleet.isBackedOff('C1', at + FLEET_REFUSAL_BACKOFF_MAX_MS)).toBe(false);
  });

  it('clears the back-off after an accepted start', () => {
    const fleet = new FleetCharging(() => 0);
    fleet.setTokens([card('C1')]);
    refuse(fleet, 'cmd-1', NOW);
    fleet.trackStart('cmd-2', 'C1', NOW + FLEET_REFUSAL_BACKOFF_MS);
    expect(fleet.onResult({ commandId: 'cmd-2', success: true }, NOW)).toBeNull();
    expect(fleet.isBackedOff('C1', NOW)).toBe(false);
    refuse(fleet, 'cmd-3', NOW);
    expect(fleet.isBackedOff('C1', NOW + FLEET_REFUSAL_BACKOFF_MS)).toBe(false);
  });

  it('ignores results of untracked commands, other failures and forgotten starts', () => {
    const fleet = new FleetCharging(() => 0);
    fleet.setTokens([card('C1')]);
    expect(
      fleet.onResult({ commandId: 'other', success: false, error: 'Authorization rejected' }, NOW),
    ).toBeNull();
    fleet.trackStart('cmd-1', 'C1', NOW);
    expect(
      fleet.onResult({ commandId: 'cmd-1', success: false, error: 'Cable not plugged in' }, NOW),
    ).toBeNull();
    expect(fleet.isBackedOff('C1', NOW)).toBe(false);

    fleet.trackStart('cmd-old', 'C1', NOW);
    fleet.trackStart('cmd-new', 'C1', NOW + FLEET_START_RESULT_TTL_MS + 1);
    expect(
      fleet.onResult(
        { commandId: 'cmd-old', success: false, error: 'Authorization rejected: NoCredit' },
        NOW,
      ),
    ).toBeNull();
  });

  it('drops the back-off of a card that left the pool', () => {
    const fleet = new FleetCharging(() => 0);
    fleet.setTokens([card('C1')]);
    refuse(fleet, 'cmd-1', NOW);
    fleet.setTokens([]);
    fleet.setTokens([card('C1')]);
    expect(fleet.isBackedOff('C1', NOW)).toBe(false);
  });

  it('reads only the simulator authorization refusal as a refusal', () => {
    expect(isAuthorizationRefusal('Authorization rejected: NoCredit')).toBe(true);
    expect(isAuthorizationRefusal('Transaction already active on this EVSE')).toBe(false);
    expect(isAuthorizationRefusal(undefined)).toBe(false);
  });
});
