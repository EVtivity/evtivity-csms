// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** GET /v1/users/me/mfa. */
export interface MfaStatus {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  availableMethods: string[];
  recoveryCodesRemaining?: number;
  recoveryCodesUsedUp?: boolean;
  /** Required MFA covers the user's role: MFA cannot be turned off. */
  requiredByPolicy?: boolean;
  /** Passkeys and security keys of the user. */
  passkeyCount?: number;
  /** The admin allows passkeys and security keys. */
  webauthnEnabled?: boolean;
  /** The admin allows signing in with a passkey alone. */
  passkeyLoginEnabled?: boolean;
  /** What adding a factor accepts as proof; `password` for an account without one. */
  factorProofKinds?: string[];
  /** The only factor is one passkey: removing it turns MFA off and needs a proof. */
  lastFactorIsPasskey?: boolean;
  /** What removing a passkey accepts as proof: a factor, or the password. */
  lastFactorProofKinds?: string[];
  /** Until when this session's SSO sign-in proves the account (the `sso` proof), ISO 8601. */
  ssoProofUntil?: string | null;
}

export const MFA_STATUS_KEY = ['mfa-status'] as const;

/** GET /v1/users/me/webauthn. */
export const PASSKEYS_KEY = ['webauthn-credentials'] as const;

export function useMfaStatus(): UseQueryResult<MfaStatus> {
  return useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: () => api.get<MfaStatus>('/v1/users/me/mfa'),
  });
}
