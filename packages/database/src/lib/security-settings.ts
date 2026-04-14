// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

export interface RecaptchaConfig {
  enabled: boolean;
  siteKey: string;
  secretKeyEnc: string;
  threshold: number;
}

export interface MfaConfig {
  emailEnabled: boolean;
  totpEnabled: boolean;
  smsEnabled: boolean;
}

let recaptchaCache: RecaptchaConfig | null | undefined;
let recaptchaCachedAt = 0;

let mfaCache: MfaConfig | undefined;
let mfaCachedAt = 0;

const TTL_MS = 60_000;

function parseSecuritySettings(rows: { key: string; value: unknown }[]): {
  recaptcha: RecaptchaConfig;
  mfa: MfaConfig;
} {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  return {
    recaptcha: {
      enabled: map.get('security.recaptcha.enabled') === true,
      siteKey:
        typeof map.get('security.recaptcha.siteKey') === 'string'
          ? (map.get('security.recaptcha.siteKey') as string)
          : '',
      secretKeyEnc:
        typeof map.get('security.recaptcha.secretKeyEnc') === 'string'
          ? (map.get('security.recaptcha.secretKeyEnc') as string)
          : '',
      threshold:
        typeof map.get('security.recaptcha.threshold') === 'number'
          ? (map.get('security.recaptcha.threshold') as number)
          : 0.5,
    },
    mfa: {
      emailEnabled: map.get('security.mfa.emailEnabled') !== false,
      totpEnabled: map.get('security.mfa.totpEnabled') !== false,
      smsEnabled: map.get('security.mfa.smsEnabled') === true,
    },
  };
}

async function fetchSecuritySettings(): Promise<{ key: string; value: unknown }[]> {
  return db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, 'security.%'));
}

export async function getRecaptchaConfig(): Promise<RecaptchaConfig | null> {
  const now = Date.now();
  if (recaptchaCache !== undefined && now - recaptchaCachedAt < TTL_MS) {
    return recaptchaCache;
  }

  try {
    const rows = await fetchSecuritySettings();
    const parsed = parseSecuritySettings(rows);
    recaptchaCache = parsed.recaptcha.enabled ? parsed.recaptcha : null;
    recaptchaCachedAt = now;
    return recaptchaCache;
  } catch {
    return recaptchaCache ?? null;
  }
}

export async function getMfaConfig(): Promise<MfaConfig> {
  const now = Date.now();
  if (mfaCache !== undefined && now - mfaCachedAt < TTL_MS) {
    return mfaCache;
  }

  try {
    const rows = await fetchSecuritySettings();
    const parsed = parseSecuritySettings(rows);
    mfaCache = parsed.mfa;
    mfaCachedAt = now;
    return mfaCache;
  } catch {
    return mfaCache ?? { emailEnabled: true, totpEnabled: true, smsEnabled: false };
  }
}

export function clearSecuritySettingsCache(): void {
  recaptchaCache = undefined;
  recaptchaCachedAt = 0;
  mfaCache = undefined;
  mfaCachedAt = 0;
}
