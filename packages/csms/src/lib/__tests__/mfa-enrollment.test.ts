// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  enrollmentPost,
  isMfaEnrollmentReply,
  mfaEnrollmentFromReply,
  readSsoEnrollmentFragment,
} from '../mfa-enrollment';
import { ApiError } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSsoEnrollmentFragment', () => {
  it('reads the enrollment token and methods of an SSO login', () => {
    expect(
      readSsoEnrollmentFragment('#ssoMfaEnrollmentToken=tok&ssoMfaEnrollmentMethods=email,totp'),
    ).toEqual({ enrollmentToken: 'tok', availableMethods: ['email', 'totp'] });
  });

  it('answers null for the MFA challenge fragment or none', () => {
    expect(readSsoEnrollmentFragment('#ssoMfaToken=tok&ssoMfaMethod=email')).toBeNull();
    expect(readSsoEnrollmentFragment('')).toBeNull();
  });
});

describe('isMfaEnrollmentReply', () => {
  it('tells the enrollment reply from a session or MFA reply', () => {
    expect(isMfaEnrollmentReply({ mfaEnrollmentRequired: true, enrollmentToken: 't' })).toBe(true);
    expect(isMfaEnrollmentReply({ token: 't', user: {} })).toBe(false);
    expect(isMfaEnrollmentReply({ mfaEnrollmentRequired: true })).toBe(false);
    expect(isMfaEnrollmentReply(null)).toBe(false);
  });

  it('keeps no methods when the reply names none', () => {
    expect(mfaEnrollmentFromReply({ mfaEnrollmentRequired: true, enrollmentToken: 't' })).toEqual({
      enrollmentToken: 't',
      availableMethods: [],
    });
  });
});

describe('enrollmentPost', () => {
  it('sends the enrollment token as the Bearer credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ challengeId: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await enrollmentPost('/v1/users/me/mfa/setup', 'tok', { method: 'email' })).toEqual({
      challengeId: 3,
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
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
    await expect(enrollmentPost('/v1/users/me/mfa/confirm', 'tok', {})).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
