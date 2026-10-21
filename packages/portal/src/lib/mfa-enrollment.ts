// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ApiError, getCsrfToken } from './api';
import { API_BASE_URL } from './config';

/** The MFA setup a portal sign-in asks for before it issues a session (required MFA for drivers). */
export interface MfaEnrollmentState {
  /** The 10-minute enrollment token: kept in memory only, never in storage. */
  enrollmentToken: string;
  availableMethods: string[];
  /** A passkey or security key can be the enrolled factor. */
  webauthnAvailable: boolean;
}

/** The reply of POST /v1/portal/auth/login when the driver must set up MFA. */
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
    webauthnAvailable: data.webauthnAvailable === true,
  };
}

/**
 * POSTs to a portal MFA setup route with the enrollment token as the Bearer
 * credential. It skips the session refresh of `api`: the enrollment token is
 * the only credential, and a refusal sends the driver back to sign in.
 */
export async function enrollmentPost<T>(
  path:
    | '/v1/portal/driver/mfa/setup'
    | '/v1/portal/driver/mfa/confirm'
    | '/v1/portal/driver/webauthn/registration-options'
    | '/v1/portal/driver/webauthn/registration',
  token: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  // The portal CSRF check applies while a portal session cookie is still in the browser.
  const csrf = getCsrfToken();
  if (csrf != null) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // The confirm sets the session cookies.
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
