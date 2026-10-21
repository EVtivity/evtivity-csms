// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrollmentPost, isMfaEnrollmentReply, mfaEnrollmentFromReply } from '../mfa-enrollment';
import { ApiError } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'portal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

describe('isMfaEnrollmentReply', () => {
  it('tells the enrollment reply from a session or MFA reply', () => {
    expect(isMfaEnrollmentReply({ mfaEnrollmentRequired: true, enrollmentToken: 't' })).toBe(true);
    expect(isMfaEnrollmentReply({ driver: {} })).toBe(false);
    expect(isMfaEnrollmentReply({ mfaRequired: true, mfaToken: 't' })).toBe(false);
    expect(isMfaEnrollmentReply({ mfaEnrollmentRequired: true })).toBe(false);
    expect(isMfaEnrollmentReply(null)).toBe(false);
  });

  it('keeps the methods and the passkey option of the reply', () => {
    expect(mfaEnrollmentFromReply({ mfaEnrollmentRequired: true, enrollmentToken: 't' })).toEqual({
      enrollmentToken: 't',
      availableMethods: [],
      webauthnAvailable: false,
    });
    expect(
      mfaEnrollmentFromReply({
        mfaEnrollmentRequired: true,
        enrollmentToken: 't',
        availableMethods: ['totp'],
        webauthnAvailable: true,
      }),
    ).toEqual({ enrollmentToken: 't', availableMethods: ['totp'], webauthnAvailable: true });
  });
});

describe('enrollmentPost', () => {
  it('sends the enrollment token as the Bearer credential, with cookies for the session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ challengeId: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrollmentPost('/v1/portal/driver/mfa/setup', 'tok', { method: 'email' })).toEqual(
      { challengeId: 3 },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/v1/portal/driver/mfa/setup')).toBe(true);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(init.credentials).toBe('include');
  });

  it('sends the portal CSRF token from the portal_csrf cookie, as the api client does', async () => {
    document.cookie = 'portal_csrf=csrf-123; path=/';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await enrollmentPost('/v1/portal/driver/mfa/confirm', 'tok', {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-123');
  });

  it('sends no CSRF header without the cookie', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await enrollmentPost('/v1/portal/driver/mfa/setup', 'tok', {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });

  it('throws ApiError with the code of a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Session ended', code: 'UNAUTHORIZED' }), {
          status: 401,
        }),
      ),
    );
    await expect(enrollmentPost('/v1/portal/driver/mfa/confirm', 'tok', {})).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
