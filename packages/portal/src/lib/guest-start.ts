// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { api } from '@/lib/api';
import { executeRecaptcha } from '@/lib/recaptcha';

/**
 * What every guest start sends besides the payment: the dynamic QR scan token
 * (required at a station with dynamic QR codes), a reCAPTCHA token when
 * reCAPTCHA is on, and the guest's UI language for its notices.
 */
export interface GuestStartExtras {
  qrToken?: string;
  recaptchaToken?: string;
  language: string;
}

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
}

const QR_TOKEN_KEY_PREFIX = 'evtivity.guestQrToken';

// Fallback when sessionStorage is unavailable (private mode, blocked storage).
const memoryTokens = new Map<string, string>();

function tokenKey(stationId: string, evseId: string | number): string {
  return `${QR_TOKEN_KEY_PREFIX}:${stationId}:${String(evseId)}`;
}

/** Keeps the scan token of a validated QR code for the start of this EVSE. */
export function storeGuestQrToken(stationId: string, evseId: string | number, token: string): void {
  const key = tokenKey(stationId, evseId);
  memoryTokens.set(key, token);
  try {
    sessionStorage.setItem(key, token);
  } catch (err) {
    console.warn('Session storage unavailable, keeping the QR scan token in memory', err);
  }
}

/** The scan token of a validated QR code for this EVSE, if any. */
export function readGuestQrToken(stationId: string, evseId: string | number): string | undefined {
  const key = tokenKey(stationId, evseId);
  try {
    const stored = sessionStorage.getItem(key);
    if (stored != null && stored !== '') return stored;
  } catch (err) {
    console.warn('Session storage unavailable, reading the QR scan token from memory', err);
  }
  return memoryTokens.get(key);
}

/** Builds the extras of a guest start; runs reCAPTCHA right before the request. */
export async function guestStartExtras(
  stationId: string,
  evseId: string | number,
  language: string,
): Promise<GuestStartExtras> {
  const security = await api.get<SecurityPublic>('/v1/security/public');
  let recaptchaToken: string | undefined;
  if (security.recaptchaEnabled && security.recaptchaSiteKey !== '') {
    recaptchaToken = await executeRecaptcha(security.recaptchaSiteKey, 'guest_start');
  }
  const qrToken = readGuestQrToken(stationId, evseId);
  return {
    language,
    ...(qrToken != null ? { qrToken } : {}),
    ...(recaptchaToken != null ? { recaptchaToken } : {}),
  };
}
