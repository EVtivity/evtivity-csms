// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  isChallengeFor,
  isPasskeyLoginChallenge,
  parseWebauthnChallengeRecord,
} from '../lib/webauthn-challenge-records.js';

const USER = 'usr_000000000001';
const DRIVER = 'drv_000000000001';

describe('parseWebauthnChallengeRecord', () => {
  it('reads operator and driver records', () => {
    expect(
      parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'factor_add', userId: USER })),
    ).toEqual({
      purpose: 'factor_add',
      userId: USER,
    });
    expect(
      parseWebauthnChallengeRecord(
        JSON.stringify({ purpose: 'registration', driverId: DRIVER, userHandle: 'h' }),
      ),
    ).toEqual({ purpose: 'registration', driverId: DRIVER, userHandle: 'h' });
    expect(
      parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'passkey_login', realm: 'driver' })),
    ).toEqual({ purpose: 'passkey_login', realm: 'driver' });
  });

  it('refuses a record with both owners, no owner, an unknown purpose or realm', () => {
    expect(
      parseWebauthnChallengeRecord(
        JSON.stringify({ purpose: 'second_factor', userId: USER, driverId: DRIVER }),
      ),
    ).toBeNull();
    expect(parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'second_factor' }))).toBeNull();
    expect(
      parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'other', userId: USER })),
    ).toBeNull();
    expect(
      parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'registration', userId: USER })),
    ).toBeNull();
    expect(parseWebauthnChallengeRecord(JSON.stringify({ purpose: 'passkey_login' }))).toBeNull();
    expect(parseWebauthnChallengeRecord('not json')).toBeNull();
  });
});

describe('isChallengeFor', () => {
  it('matches the purpose and the account, never across operators and drivers', () => {
    const operator = { purpose: 'second_factor' as const, userId: USER };
    const driver = { purpose: 'second_factor' as const, driverId: DRIVER };
    expect(isChallengeFor(operator, 'second_factor', { userId: USER })).toBe(true);
    expect(isChallengeFor(driver, 'second_factor', { driverId: DRIVER })).toBe(true);
    // A driver challenge never answers an operator ceremony, even with the same id string.
    expect(
      isChallengeFor({ purpose: 'second_factor', driverId: USER }, 'second_factor', {
        userId: USER,
      }),
    ).toBe(false);
    expect(isChallengeFor(operator, 'second_factor', { driverId: USER })).toBe(false);
    expect(isChallengeFor(operator, 'factor_add', { userId: USER })).toBe(false);
    expect(isChallengeFor(operator, 'second_factor', { userId: 'usr_000000000002' })).toBe(false);
    expect(isChallengeFor(null, 'second_factor', { userId: USER })).toBe(false);
    expect(
      isChallengeFor({ purpose: 'passkey_login', realm: 'operator' }, 'second_factor', {
        userId: USER,
      }),
    ).toBe(false);
  });
});

describe('isPasskeyLoginChallenge', () => {
  it('matches the realm of the sign-in', () => {
    expect(isPasskeyLoginChallenge({ purpose: 'passkey_login', realm: 'driver' }, 'driver')).toBe(
      true,
    );
    expect(isPasskeyLoginChallenge({ purpose: 'passkey_login', realm: 'driver' }, 'operator')).toBe(
      false,
    );
    expect(isPasskeyLoginChallenge({ purpose: 'factor_add', userId: USER }, 'operator')).toBe(
      false,
    );
    expect(isPasskeyLoginChallenge(null, 'driver')).toBe(false);
  });
});
