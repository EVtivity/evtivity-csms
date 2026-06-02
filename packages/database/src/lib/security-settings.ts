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

interface ParsedSecurity {
  recaptcha: RecaptchaConfig;
  mfa: MfaConfig;
}

let cache: ParsedSecurity | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;
const MFA_FALLBACK: MfaConfig = { emailEnabled: true, totpEnabled: true, smsEnabled: false };

function parseSecuritySettings(rows: { key: string; value: unknown }[]): ParsedSecurity {
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

async function loadSecuritySettings(): Promise<ParsedSecurity | undefined> {
  const now = Date.now();
  if (cache !== undefined && now - cachedAt < TTL_MS) {
    return cache;
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'security.%'));
    cache = parseSecuritySettings(rows);
    cachedAt = now;
    return cache;
  } catch {
    return cache;
  }
}

export async function getRecaptchaConfig(): Promise<RecaptchaConfig | null> {
  const parsed = await loadSecuritySettings();
  if (parsed == null) return null;
  return parsed.recaptcha.enabled ? parsed.recaptcha : null;
}

export async function getMfaConfig(): Promise<MfaConfig> {
  const parsed = await loadSecuritySettings();
  return parsed?.mfa ?? MFA_FALLBACK;
}

export function clearSecuritySettingsCache(): void {
  cache = undefined;
  cachedAt = 0;
}
