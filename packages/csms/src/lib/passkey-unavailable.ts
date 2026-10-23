// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { WebauthnUnavailableReason } from './webauthn';

/** Where a passkey the account depends on cannot be used on this page. */
export type PasskeyUnavailableContext =
  /** The sign-in verification also takes a verification code. */
  | 'signInCode'
  /** The sign-in verification also takes a recovery code. */
  | 'signInRecovery'
  /** The sign-in verification takes a passkey only. */
  | 'signInOnly'
  /** MFA setup offers other methods too. */
  | 'setupOther'
  /** MFA setup offers a passkey only. */
  | 'setupOnly'
  /** The "confirm it's you" proof takes a passkey only. */
  | 'proofOnly';

export type PasskeyUnavailableKey =
  `passkeyUnavailable.${WebauthnUnavailableReason}.${PasskeyUnavailableContext}`;

/** The note that says why a passkey cannot be used here and what to do instead. */
export function passkeyUnavailableKey(
  reason: WebauthnUnavailableReason,
  context: PasskeyUnavailableContext,
): PasskeyUnavailableKey {
  return `passkeyUnavailable.${reason}.${context}`;
}

/** The sign-in context: what else the verification step takes. */
export function signInPasskeyContext(
  codeOffered: boolean,
  recoveryOffered: boolean,
): PasskeyUnavailableContext {
  if (codeOffered) return 'signInCode';
  return recoveryOffered ? 'signInRecovery' : 'signInOnly';
}
