// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { API_BASE_URL } from './config';
import { rememberReturnPath } from './return-to';

/**
 * SSO sign-in binding: before it leaves for the identity provider, this tab
 * keeps a random state in sessionStorage and sends it to the API, which hands
 * it back in the URL fragment of an SSO sign-in that needs MFA. The login page
 * acts only on a fragment that carries this tab's state, so a link with the
 * MFA state of someone else's sign-in does nothing.
 */
const SSO_STATE_KEY = 'csms_sso_state';

/** 24 random bytes as base64url: 32 characters, inside the API's 16 to 64. */
export function newSsoState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The SSO login URL with a new state kept for this tab. */
export function ssoLoginUrl(): string {
  const state = newSsoState();
  try {
    sessionStorage.setItem(SSO_STATE_KEY, state);
  } catch (err) {
    console.warn('Keep the SSO sign-in state failed, an MFA step will not continue', err);
  }
  return `${API_BASE_URL}/v1/auth/sso/login?state=${state}`;
}

/** Starts SSO, coming back to `returnTo` (a same-origin path) when given. */
export function startSsoSignIn(returnTo?: string): void {
  if (returnTo != null) rememberReturnPath(returnTo);
  window.location.assign(ssoLoginUrl());
}

/** The kept state, once: it is cleared as it is read. */
function takeSsoState(): string | null {
  try {
    const state = sessionStorage.getItem(SSO_STATE_KEY);
    sessionStorage.removeItem(SSO_STATE_KEY);
    return state;
  } catch (err) {
    console.warn('Read the SSO sign-in state failed', err);
    return null;
  }
}

/** Whether a URL fragment holds the MFA state of an SSO sign-in. */
export function hasSsoMfaFragment(hash: string): boolean {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return params.has('ssoMfaToken') || params.has('ssoMfaEnrollmentToken');
}

/** Whether the fragment carries the state this tab kept when it started SSO (uses the state up). */
export function ssoFragmentFromThisTab(hash: string): boolean {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const sent = params.get('ssoState');
  const kept = takeSsoState();
  return sent != null && sent !== '' && kept != null && sent === kept;
}
