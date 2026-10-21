// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** GET /v1/portal/driver/mfa. */
export interface PortalMfaStatus {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  availableMethods: string[];
  recoveryCodesRemaining?: number;
  recoveryCodesUsedUp?: boolean;
  /** Required MFA covers drivers: MFA cannot be turned off and the last factor stays. */
  requiredByPolicy?: boolean;
  passkeyCount?: number;
  webauthnEnabled?: boolean;
  passkeyLoginEnabled?: boolean;
  /** The proofs adding a factor accepts. */
  factorProofKinds?: string[];
  /** The only factor is one passkey: removing it turns MFA off. */
  lastFactorIsPasskey?: boolean;
  /** The proofs removing a passkey accepts: a factor, or the password. */
  lastFactorProofKinds?: string[];
}

export const MFA_STATUS_KEY = ['portal-mfa-status'] as const;
export const PASSKEYS_KEY = ['portal-passkeys'] as const;
