// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ApiError } from './api';
import { API_BASE_URL } from './config';

/** The MFA setup a sign-in asks for before it issues a session (required MFA, or a switched-off only factor). */
export interface MfaEnrollmentState {
  /** The 10-minute enrollment token: kept in memory only, never in storage. */
  enrollmentToken: string;
  availableMethods: string[];
  /** A passkey or security key can be the enrolled factor. Unknown for the SSO fragment. */
  webauthnAvailable?: boolean;
}

/** The reply of login, forced password change and MFA verify when the user must set up MFA. */
export interface MfaEnrollmentReply {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
  availableMethods?: string[];
  webauthnAvailable?: boolean;
}

export function isMfaEnrollmentReply(data: unknown): data is MfaEnrollmentReply {
  if (data == null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record['mfaEnrollmentRequired'] === true && typeof record['enrollmentToken'] === 'string';
}

export function mfaEnrollmentFromReply(data: MfaEnrollmentReply): MfaEnrollmentState {
  return {
    enrollmentToken: data.enrollmentToken,
    availableMethods: data.availableMethods ?? [],
    ...(data.webauthnAvailable != null ? { webauthnAvailable: data.webauthnAvailable } : {}),
  };
}

/**
 * Reads the enrollment state from the URL fragment the SSO callback redirects
 * to (`/login#ssoMfaEnrollmentToken=...&ssoMfaEnrollmentMethods=...`). Null
 * when the fragment holds none.
 */
export function readSsoEnrollmentFragment(hash: string): MfaEnrollmentState | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('ssoMfaEnrollmentToken');
  if (token == null || token === '') return null;
  const methods = params.get('ssoMfaEnrollmentMethods') ?? '';
  return { enrollmentToken: token, availableMethods: methods.split(',').filter(Boolean) };
}

/**
 * POSTs to an MFA setup route with the enrollment token as the Bearer
 * credential. It skips the session refresh of `api`: the enrollment token is
 * the only credential, and a refusal sends the user back to sign in.
 */
export async function enrollmentPost<T>(
  path:
    | '/v1/users/me/mfa/setup'
    | '/v1/users/me/mfa/confirm'
    | '/v1/users/me/webauthn/registration-options'
    | '/v1/users/me/webauthn/registration',
  token: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) {
    const errorBody: unknown = await (res.json() as Promise<unknown>).catch((err: unknown) => {
      console.warn('MFA setup error body is not JSON', err);
      return null;
    });
    throw new ApiError(res.status, errorBody);
  }
  return res.json() as Promise<T>;
}
