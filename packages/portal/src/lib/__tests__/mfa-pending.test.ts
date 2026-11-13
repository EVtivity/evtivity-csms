// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { mfaPendingFromReply } from '../mfa-pending';

describe('mfaPendingFromReply', () => {
  it('keeps the method and token, the challenge id as text, and only the known factors', () => {
    expect(
      mfaPendingFromReply({
        mfaRequired: true,
        mfaMethod: 'sms',
        mfaToken: 't',
        challengeId: 42,
        factors: ['sms', 'recovery_code', 'carrier_pigeon', 'passkey'],
        mfaMethodDisabled: true,
      }),
    ).toEqual({
      mfaRequired: true,
      mfaMethod: 'sms',
      mfaToken: 't',
      challengeId: '42',
      factors: ['sms', 'recovery_code', 'passkey'],
      mfaMethodDisabled: true,
    });
  });

  it('leaves out what an older API does not send', () => {
    expect(
      mfaPendingFromReply({
        mfaRequired: true,
        mfaMethod: 'totp',
        mfaToken: 't',
        mfaMethodDisabled: false,
      }),
    ).toEqual({ mfaRequired: true, mfaMethod: 'totp', mfaToken: 't' });
  });
});
