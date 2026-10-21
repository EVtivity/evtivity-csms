// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { readSsoMfaFragment } from '../sso-mfa';

describe('readSsoMfaFragment', () => {
  it('reads the MFA pending state of an SSO login', () => {
    expect(readSsoMfaFragment('#ssoMfaToken=tok&ssoMfaMethod=email&ssoMfaChallengeId=42')).toEqual({
      mfaRequired: true,
      mfaMethod: 'email',
      mfaToken: 'tok',
      challengeId: '42',
    });
  });

  it('leaves out the challenge for an authenticator app', () => {
    expect(readSsoMfaFragment('#ssoMfaToken=tok&ssoMfaMethod=totp')).toEqual({
      mfaRequired: true,
      mfaMethod: 'totp',
      mfaToken: 'tok',
    });
  });

  it('reads the factors and a switched-off method', () => {
    expect(
      readSsoMfaFragment(
        '#ssoMfaToken=tok&ssoMfaMethod=sms&ssoMfaFactors=recovery_code,bogus&ssoMfaMethodDisabled=1',
      ),
    ).toEqual({
      mfaRequired: true,
      mfaMethod: 'sms',
      mfaToken: 'tok',
      factors: ['recovery_code'],
      mfaMethodDisabled: true,
    });
  });

  it('returns null without a token or a method', () => {
    expect(readSsoMfaFragment('')).toBeNull();
    expect(readSsoMfaFragment('#ssoMfaMethod=email')).toBeNull();
    expect(readSsoMfaFragment('#ssoMfaToken=tok')).toBeNull();
    expect(readSsoMfaFragment('#ssoMfaToken=&ssoMfaMethod=email')).toBeNull();
  });
});
