// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { ApiError } from './api';
import { getErrorMessage, rateLimitedMessage } from './error-message';

/**
 * Passkeys work only on a secure page (HTTPS, or localhost) in a browser with
 * WebAuthn. Every passkey option is hidden otherwise.
 */
export function webauthnSupported(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  return browserSupportsWebAuthn();
}

/** Whether the browser can offer passkeys in the email field's autofill list. */
export async function webauthnAutofillSupported(): Promise<boolean> {
  if (!webauthnSupported()) return false;
  return browserSupportsWebAuthnAutofill();
}

/**
 * The name a new credential gets until the user picks one, sent with the
 * registration so it is stored in the user's language: "Passkey" or "Security Key".
 */
export function passkeyDefaultNameKey(
  credential: Pick<RegistrationResponseJSON, 'authenticatorAttachment'>,
): 'passkeys.defaultNameSecurityKey' | 'passkeys.defaultNamePasskey' {
  return credential.authenticatorAttachment === 'cross-platform'
    ? 'passkeys.defaultNameSecurityKey'
    : 'passkeys.defaultNamePasskey';
}

/** Why a browser passkey prompt ended without a credential. */
export type CeremonyFailure = 'cancelled' | 'aborted' | 'already_registered' | 'failed';

function errorField(err: unknown, field: 'name' | 'code'): unknown {
  return err != null && typeof err === 'object' ? (err as Record<string, unknown>)[field] : null;
}

/**
 * The reason a browser prompt failed, or null for an API error. A user who
 * closes the prompt gets NotAllowedError; a prompt the page cancels (another
 * prompt started, the page closed) gets the aborted code.
 */
export function ceremonyFailure(err: unknown): CeremonyFailure | null {
  if (err instanceof ApiError) return null;
  const code = errorField(err, 'code');
  const name = errorField(err, 'name');
  if (code === 'ERROR_CEREMONY_ABORTED' || name === 'AbortError') return 'aborted';
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return 'already_registered';
  }
  if (name === 'NotAllowedError') return 'cancelled';
  return 'failed';
}

/** The text a failed passkey step shows: a quiet note for a closed prompt, else an error. */
export interface PasskeyErrorText {
  message: string;
  quiet: boolean;
}

export function passkeyErrorText(
  err: unknown,
  t: TFunction,
  fallbackKey: 'passkeys.failed' | 'auth.passkeyFailed' = 'passkeys.failed',
): PasskeyErrorText {
  const failure = ceremonyFailure(err);
  if (failure == null) {
    return {
      message: rateLimitedMessage(err, t) ?? getErrorMessage(err, t, fallbackKey),
      quiet: false,
    };
  }
  if (failure === 'cancelled' || failure === 'aborted') {
    return { message: t('passkeys.cancelled'), quiet: true };
  }
  if (failure === 'already_registered') {
    return { message: t('passkeys.alreadyRegistered'), quiet: false };
  }
  return { message: t(fallbackKey), quiet: false };
}
