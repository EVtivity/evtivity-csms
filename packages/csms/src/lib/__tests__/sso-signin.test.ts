// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import { hasSsoMfaFragment, newSsoState, ssoFragmentFromThisTab, ssoLoginUrl } from '../sso-signin';

beforeEach(() => {
  sessionStorage.clear();
});

describe('SSO sign-in state (security review Info 3)', () => {
  it('makes a new 32-character base64url state each time', () => {
    const a = newSsoState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newSsoState()).not.toBe(a);
  });

  it('keeps the state it sends to the API for this tab', () => {
    const url = ssoLoginUrl();
    const state = new URL(url, 'https://csms.example.com').searchParams.get('state');
    expect(state).toBe(sessionStorage.getItem('csms_sso_state'));
  });

  it('accepts a fragment only with the kept state, and only once', () => {
    sessionStorage.setItem('csms_sso_state', 'keptStateAbcdefghijklm');
    expect(ssoFragmentFromThisTab('#ssoMfaToken=t&ssoState=keptStateAbcdefghijklm')).toBe(true);
    expect(ssoFragmentFromThisTab('#ssoMfaToken=t&ssoState=keptStateAbcdefghijklm')).toBe(false);
  });

  it('refuses a fragment without a state, with another state, or with no kept state', () => {
    sessionStorage.setItem('csms_sso_state', 'keptStateAbcdefghijklm');
    expect(ssoFragmentFromThisTab('#ssoMfaToken=t')).toBe(false);
    sessionStorage.setItem('csms_sso_state', 'keptStateAbcdefghijklm');
    expect(ssoFragmentFromThisTab('#ssoMfaToken=t&ssoState=otherStateAbcdefghijk')).toBe(false);
    expect(ssoFragmentFromThisTab('#ssoMfaToken=t&ssoState=keptStateAbcdefghijklm')).toBe(false);
  });

  it('recognizes the MFA fragments of an SSO sign-in', () => {
    expect(hasSsoMfaFragment('#ssoMfaToken=t&ssoMfaMethod=totp')).toBe(true);
    expect(hasSsoMfaFragment('#ssoMfaEnrollmentToken=t')).toBe(true);
    expect(hasSsoMfaFragment('#section-2')).toBe(false);
  });
});
