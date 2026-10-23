// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

export interface RecaptchaResult {
  success: boolean;
  score: number;
  action?: string;
  errorCodes?: string[];
}

/**
 * What the token must have been made for: the action the
 * page ran it with, and one of the app hosts the page was served from. A token made on
 * another site with the same site key, or for another form, is refused.
 */
export interface RecaptchaExpectation {
  action: string;
  hostnames: readonly string[];
}

/** Longest wait for the reCAPTCHA verify endpoint. */
export const RECAPTCHA_VERIFY_TIMEOUT_MS = 10_000;

export async function verifyRecaptcha(
  token: string,
  secretKey: string,
  threshold: number,
  expected?: RecaptchaExpectation,
): Promise<RecaptchaResult> {
  const params = new URLSearchParams();
  params.set('secret', secretKey);
  params.set('response', token);

  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    // A slow verify endpoint never holds a sign-in request for the
    // undici default (300 s); a timeout fails like a network error.
    signal: AbortSignal.timeout(RECAPTCHA_VERIFY_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { success: false, score: 0, errorCodes: [`HTTP ${String(res.status)}`] };
  }

  const data = (await res.json()) as {
    success: boolean;
    score?: number;
    action?: string;
    hostname?: string;
    'error-codes'?: string[];
  };

  const score = data.score ?? 0;
  const matches =
    expected == null ||
    (data.action === expected.action &&
      data.hostname != null &&
      expected.hostnames.includes(data.hostname.toLowerCase()));

  return {
    success: data.success && score >= threshold && matches,
    score,
    ...(data.action != null ? { action: data.action } : {}),
    ...(data['error-codes'] != null ? { errorCodes: data['error-codes'] } : {}),
  };
}
