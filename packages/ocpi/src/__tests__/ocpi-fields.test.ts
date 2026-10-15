// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  bodyIdentityMismatch,
  fitsOcpiString,
  isOcpiGeoLocation,
  overlongParam,
  patchChangesIdentity,
} from '../lib/ocpi-fields.js';
import { receivedSessionUpdateAllowed } from '../lib/received-session-order.js';
import { dedupeByKey } from '../services/pull.service.js';

describe('isOcpiGeoLocation', () => {
  it.each([
    ['52.520008', '13.404954'],
    ['-33.86882', '151.20929'],
    ['0.0000000', '-179.9999999'],
  ])('accepts %s, %s', (latitude, longitude) => {
    expect(isOcpiGeoLocation({ latitude, longitude })).toBe(true);
  });

  it.each([
    [{ latitude: '52.5', longitude: '13.404954' }],
    [{ latitude: '52.520008', longitude: '13.4' }],
    [{ latitude: '152.520008', longitude: '13.404954' }],
    [{ latitude: '95.000000', longitude: '13.404954' }],
    [{ latitude: '52.520008', longitude: '181.000000' }],
    [{ latitude: '52,520008', longitude: '13.404954' }],
    [{ latitude: '1e1', longitude: '13.404954' }],
    [{ latitude: 52.520008, longitude: 13.404954 }],
    [{ latitude: '52.520008' }],
    [null],
    ['52.520008,13.404954'],
  ])('refuses %j', (coords) => {
    expect(isOcpiGeoLocation(coords)).toBe(false);
  });
});

describe('fitsOcpiString and overlongParam', () => {
  it('requires a non-empty string within the length', () => {
    expect(fitsOcpiString('ABC', 3)).toBe(true);
    expect(fitsOcpiString('ABCD', 3)).toBe(false);
    expect(fitsOcpiString('', 3)).toBe(false);
    expect(fitsOcpiString(5, 3)).toBe(false);
  });

  it('names the first URL parameter longer than its OCPI field', () => {
    expect(overlongParam({ country_code: 'DE', party_id: 'ABC', location_id: 'L1' })).toBeNull();
    expect(overlongParam({ country_code: 'DEU', party_id: 'ABC' })).toBe('country_code');
    expect(overlongParam({ country_code: 'DE', party_id: 'ABCD' })).toBe('party_id');
    expect(overlongParam({ session_id: 'S'.repeat(37) })).toBe('session_id');
    expect(overlongParam({ token_uid: 'T'.repeat(36) })).toBeNull();
    expect(overlongParam({ unknown: 'x'.repeat(100) })).toBeNull();
  });
});

describe('identity checks', () => {
  it('bodyIdentityMismatch names the first field that differs from the URL', () => {
    const body = { id: 'L1', country_code: 'DE', party_id: 'ABC' };
    expect(bodyIdentityMismatch(body, { id: 'L1', country_code: 'DE' })).toBeNull();
    expect(bodyIdentityMismatch(body, { id: 'L2' })).toBe('id');
    expect(bodyIdentityMismatch({ id: 'L1' }, { id: 'L1', party_id: 'ABC' })).toBe('party_id');
  });

  it('patchChangesIdentity allows absent and equal fields only', () => {
    const current = { uid: 'U1', country_code: 'DE', party_id: 'ABC' };
    const fields = ['uid', 'country_code', 'party_id'];
    expect(patchChangesIdentity({ valid: false }, current, fields)).toBeNull();
    expect(patchChangesIdentity({ uid: 'U1' }, current, fields)).toBeNull();
    expect(patchChangesIdentity({ uid: 'U2' }, current, fields)).toBe('uid');
    expect(patchChangesIdentity({ party_id: null }, current, fields)).toBe('party_id');
  });
});

describe('receivedSessionUpdateAllowed', () => {
  const stored = { status: 'ACTIVE', last_updated: '2026-09-01T10:30:00Z' };

  it('applies a newer or equally old update', () => {
    expect(
      receivedSessionUpdateAllowed(stored, { ...stored, last_updated: '2026-09-01T10:31:00Z' }),
    ).toBe(true);
    expect(receivedSessionUpdateAllowed(stored, stored)).toBe(true);
  });

  it('ignores an update older than the stored session', () => {
    expect(
      receivedSessionUpdateAllowed(stored, { ...stored, last_updated: '2026-09-01T10:29:59Z' }),
    ).toBe(false);
  });

  it('applies the update when either last_updated is missing or unreadable', () => {
    expect(receivedSessionUpdateAllowed({ status: 'ACTIVE' }, { status: 'ACTIVE' })).toBe(true);
    expect(
      receivedSessionUpdateAllowed(stored, { status: 'ACTIVE', last_updated: 'yesterday' }),
    ).toBe(true);
  });

  it.each([
    ['COMPLETED', 'ACTIVE', false],
    ['COMPLETED', 'PENDING', false],
    ['INVALID', 'RESERVATION', false],
    ['INVALID', 'COMPLETED', false],
    ['COMPLETED', 'INVALID', true],
    ['COMPLETED', 'COMPLETED', true],
    ['ACTIVE', 'COMPLETED', true],
    ['PENDING', 'ACTIVE', true],
  ])('status %s to %s: %s', (from, to, allowed) => {
    expect(
      receivedSessionUpdateAllowed(
        { status: from, last_updated: '2026-09-01T10:00:00Z' },
        { status: to, last_updated: '2026-09-01T11:00:00Z' },
      ),
    ).toBe(allowed);
  });
});

describe('dedupeByKey', () => {
  it('keeps one row per key, the last occurrence, in the order of last occurrence', () => {
    const rows = [
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
      { k: 'a', v: 3 },
    ];
    expect(dedupeByKey(rows, (r) => r.k)).toEqual([
      { k: 'b', v: 2 },
      { k: 'a', v: 3 },
    ]);
  });
});
