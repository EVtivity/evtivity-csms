// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

export interface RecaptchaResult {
  success: boolean;
  score: number;
  action?: string;
  errorCodes?: string[];
}

export async function verifyRecaptcha(
  token: string,
  secretKey: string,
  threshold: number,
): Promise<RecaptchaResult> {
  const params = new URLSearchParams();
  params.set('secret', secretKey);
  params.set('response', token);

  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    return { success: false, score: 0, errorCodes: [`HTTP ${String(res.status)}`] };
  }

  const data = (await res.json()) as {
    success: boolean;
    score?: number;
    action?: string;
    'error-codes'?: string[];
  };

  const score = data.score ?? 0;

  return {
    success: data.success && score >= threshold,
    score,
    ...(data.action != null ? { action: data.action } : {}),
    ...(data['error-codes'] != null ? { errorCodes: data['error-codes'] } : {}),
  };
}
