// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { parseMfaFactors, type MfaPendingState } from './mfa-pending';

/** The MFA pending state an SSO login hands to the login page. */
export type SsoMfaPending = MfaPendingState;

/**
 * Reads the MFA pending state from the URL fragment the SSO callback
 * redirects to (`/login#ssoMfaToken=...&ssoMfaMethod=...`, `ssoMfaFragment`
 * in the API) for a user with MFA enabled. Null when the fragment holds none.
 */
export function readSsoMfaFragment(hash: string): SsoMfaPending | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const mfaToken = params.get('ssoMfaToken');
  const mfaMethod = params.get('ssoMfaMethod');
  if (mfaToken == null || mfaToken === '' || mfaMethod == null || mfaMethod === '') return null;
  const challengeId = params.get('ssoMfaChallengeId');
  const factors = params.get('ssoMfaFactors');
  return {
    mfaRequired: true,
    mfaMethod,
    mfaToken,
    ...(challengeId != null && challengeId !== '' ? { challengeId } : {}),
    ...(factors != null ? { factors: parseMfaFactors(factors.split(',').filter(Boolean)) } : {}),
    ...(params.get('ssoMfaMethodDisabled') === '1' ? { mfaMethodDisabled: true } : {}),
  };
}
