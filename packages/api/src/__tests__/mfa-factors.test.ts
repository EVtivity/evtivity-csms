// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  hasMfa,
  isMfaMethodAllowed,
  mfaMethodGate,
  mfaSignInFactors,
  passkeyGate,
  usableFactors,
} from '../lib/mfa-factors.js';

const ALL_ON = {
  emailEnabled: true,
  totpEnabled: true,
  smsEnabled: true,
  required: 'off' as const,
  requiredRoles: [] as string[],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  requireDrivers: false,
};
const PASSKEYS_OFF = { ...ALL_ON, webauthnEnabled: false };
const EMAIL_OFF = { ...ALL_ON, emailEnabled: false };
const read = (config: typeof ALL_ON) => ({ config, fallback: false });
// What the reader hands back when the settings read failed with nothing cached.
const FALLBACK = {
  config: { ...ALL_ON, smsEnabled: false },
  fallback: true,
};

describe('isMfaMethodAllowed', () => {
  it('follows the switch of each method', () => {
    expect(isMfaMethodAllowed('email', EMAIL_OFF)).toBe(false);
    expect(isMfaMethodAllowed('totp', EMAIL_OFF)).toBe(true);
    expect(isMfaMethodAllowed('sms', { ...ALL_ON, smsEnabled: false })).toBe(false);
  });

  it('refuses an unknown method', () => {
    expect(isMfaMethodAllowed('carrier-pigeon', ALL_ON)).toBe(false);
  });
});

describe('usableFactors', () => {
  it('lists the primary method while its switch is on', () => {
    expect(usableFactors({ mfaEnabled: true, mfaMethod: 'email' }, read(ALL_ON))).toEqual([
      'email',
    ]);
  });

  it('leaves out a switched-off method', () => {
    expect(usableFactors({ mfaEnabled: true, mfaMethod: 'email' }, read(EMAIL_OFF))).toEqual([]);
  });

  it('lists nothing for an account without MFA', () => {
    expect(usableFactors({ mfaEnabled: false, mfaMethod: 'totp' }, read(ALL_ON))).toEqual([]);
  });

  it('counts recovery codes and passkeys whatever the method switches say', () => {
    expect(
      usableFactors(
        { mfaEnabled: true, mfaMethod: 'email', recoveryCodesRemaining: 3, passkeyCount: 1 },
        read(EMAIL_OFF),
      ),
    ).toEqual(['recovery_code', 'passkey']);
  });

  it('fails closed on a failed settings read: drops a method the defaults switch off while another factor remains', () => {
    expect(
      usableFactors({ mfaEnabled: true, mfaMethod: 'sms', recoveryCodesRemaining: 2 }, FALLBACK),
    ).toEqual(['recovery_code']);
    expect(
      usableFactors({ mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 1 }, FALLBACK),
    ).toEqual(['passkey']);
    expect(
      usableFactors({ mfaEnabled: true, mfaMethod: 'email', recoveryCodesRemaining: 2 }, FALLBACK),
    ).toEqual(['email', 'recovery_code']);
  });

  it('keeps the only factor on a failed settings read', () => {
    expect(usableFactors({ mfaEnabled: true, mfaMethod: 'sms' }, FALLBACK)).toEqual(['sms']);
  });
});

describe('mfaMethodGate', () => {
  it('allows a method whose switch is on', () => {
    expect(mfaMethodGate({ mfaEnabled: true, mfaMethod: 'totp' }, read(EMAIL_OFF))).toBe('allowed');
  });

  it('accepts a switched-off method that is the only factor and asks for enrollment', () => {
    expect(mfaMethodGate({ mfaEnabled: true, mfaMethod: 'email' }, read(EMAIL_OFF))).toBe(
      'enrollment_required',
    );
  });

  it('refuses a switched-off method when the account has another usable factor', () => {
    expect(
      mfaMethodGate(
        { mfaEnabled: true, mfaMethod: 'email', recoveryCodesRemaining: 2 },
        read(EMAIL_OFF),
      ),
    ).toBe('refused');
    expect(
      mfaMethodGate(
        { mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 1 },
        read({ ...ALL_ON, smsEnabled: false }),
      ),
    ).toBe('refused');
  });

  it('does not count used-up recovery codes as another factor', () => {
    expect(
      mfaMethodGate(
        { mfaEnabled: true, mfaMethod: 'email', recoveryCodesRemaining: 0 },
        read(EMAIL_OFF),
      ),
    ).toBe('enrollment_required');
  });

  it('fails closed on a failed settings read: refuses a method the defaults switch off when another factor remains', () => {
    // SMS is off in the defaults; with recovery codes or a passkey left, the user proves one of those.
    expect(
      mfaMethodGate({ mfaEnabled: true, mfaMethod: 'sms', recoveryCodesRemaining: 5 }, FALLBACK),
    ).toBe('refused');
    expect(mfaMethodGate({ mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 1 }, FALLBACK)).toBe(
      'refused',
    );
    expect(
      mfaSignInFactors({ mfaEnabled: true, mfaMethod: 'sms', recoveryCodesRemaining: 5 }, FALLBACK),
    ).toEqual({ gate: 'refused', factors: ['recovery_code'], methodDisabled: true });
  });

  it('keeps accepting the method on a failed settings read while it is the only factor', () => {
    expect(mfaMethodGate({ mfaEnabled: true, mfaMethod: 'sms' }, FALLBACK)).toBe('allowed');
    expect(mfaSignInFactors({ mfaEnabled: true, mfaMethod: 'sms' }, FALLBACK)).toEqual({
      gate: 'allowed',
      factors: ['sms'],
      methodDisabled: false,
    });
  });

  it('allows a method the defaults keep on when the settings read failed', () => {
    expect(
      mfaMethodGate({ mfaEnabled: true, mfaMethod: 'totp', recoveryCodesRemaining: 5 }, FALLBACK),
    ).toBe('allowed');
  });
});

describe('mfaSignInFactors', () => {
  it('offers the method and the recovery codes while the method is on', () => {
    expect(
      mfaSignInFactors(
        { mfaEnabled: true, mfaMethod: 'totp', recoveryCodesRemaining: 4 },
        read(ALL_ON),
      ),
    ).toEqual({ gate: 'allowed', factors: ['totp', 'recovery_code'], methodDisabled: false });
  });

  it('offers only the recovery codes and flags the method when it is switched off', () => {
    expect(
      mfaSignInFactors(
        { mfaEnabled: true, mfaMethod: 'email', recoveryCodesRemaining: 4 },
        read(EMAIL_OFF),
      ),
    ).toEqual({ gate: 'refused', factors: ['recovery_code'], methodDisabled: true });
  });

  it('offers the switched-off method while it is the only factor', () => {
    expect(mfaSignInFactors({ mfaEnabled: true, mfaMethod: 'email' }, read(EMAIL_OFF))).toEqual({
      gate: 'enrollment_required',
      factors: ['email'],
      methodDisabled: false,
    });
  });
});

describe('passkeys', () => {
  it('counts passkeys only while WebAuthn is switched on, or the settings read failed', () => {
    expect(
      usableFactors({ mfaEnabled: false, mfaMethod: null, passkeyCount: 2 }, read(ALL_ON)),
    ).toEqual(['passkey']);
    expect(
      usableFactors({ mfaEnabled: false, mfaMethod: null, passkeyCount: 2 }, read(PASSKEYS_OFF)),
    ).toEqual([]);
    expect(
      usableFactors(
        { mfaEnabled: false, mfaMethod: null, passkeyCount: 2 },
        { config: PASSKEYS_OFF, fallback: true },
      ),
    ).toEqual(['passkey']);
  });

  it('refuses switched-off passkeys while another factor remains, else asks for enrollment', () => {
    expect(
      passkeyGate({ mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 1 }, read(PASSKEYS_OFF)),
    ).toBe('refused');
    expect(
      passkeyGate({ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 }, read(PASSKEYS_OFF)),
    ).toBe('enrollment_required');
    expect(passkeyGate({ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 }, read(ALL_ON))).toBe(
      'allowed',
    );
    expect(passkeyGate({ mfaEnabled: false, mfaMethod: null }, read(PASSKEYS_OFF))).toBe('allowed');
  });

  it('offers switched-off passkeys while they are the only factor', () => {
    expect(
      mfaSignInFactors({ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 }, read(PASSKEYS_OFF)),
    ).toEqual({ gate: 'allowed', factors: ['passkey'], methodDisabled: false });
  });

  it('treats a passkey as MFA without a primary method', () => {
    expect(hasMfa({ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 })).toBe(true);
    expect(hasMfa({ mfaEnabled: true, mfaMethod: 'email' })).toBe(true);
    expect(hasMfa({ mfaEnabled: false, mfaMethod: 'email', passkeyCount: 0 })).toBe(false);
  });
});
