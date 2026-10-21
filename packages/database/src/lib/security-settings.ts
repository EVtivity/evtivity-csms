// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import {
  createLogger,
  DEFAULT_MFA_CONFIG,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_SESSION_LIFETIMES,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  SESSION_LIFETIME_LIMITS,
  normalizeMfaConfig,
  normalizePasswordPolicy,
  normalizeSessionLifetimes,
} from '@evtivity/lib';
import type { MfaConfig, PasswordPolicy, SessionLifetimes } from '@evtivity/lib';

const logger = createLogger('security-settings');

export interface RecaptchaConfig {
  enabled: boolean;
  siteKey: string;
  secretKeyEnc: string;
  threshold: number;
}

export type { MfaConfig };

interface ParsedSecurity {
  recaptcha: RecaptchaConfig;
  mfa: MfaConfig;
  passwordPolicy: PasswordPolicy;
  sessionLifetimes: SessionLifetimes;
}

let cache: ParsedSecurity | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;
const MFA_FALLBACK: MfaConfig = { ...DEFAULT_MFA_CONFIG };

function withPrefix(map: Map<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of map) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a stored password policy or session lifetime value is usable as stored. */
const STORED_VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  'security.password.minLength': (value) =>
    inRange(value, PASSWORD_MIN_LENGTH_FLOOR, PASSWORD_MIN_LENGTH_CEILING),
  'security.password.requireUppercase': (value) => typeof value === 'boolean',
  'security.password.requireLowercase': (value) => typeof value === 'boolean',
  'security.password.requireNumber': (value) => typeof value === 'boolean',
  'security.password.requireSymbol': (value) => typeof value === 'boolean',
  ...Object.fromEntries(
    Object.entries(SESSION_LIFETIME_LIMITS).map(([field, { min, max }]) => [
      `security.session.${field}`,
      (value: unknown) => inRange(value, min, max),
    ]),
  ),
};

function warnOnInvalidStoredValues(map: Map<string, unknown>): void {
  for (const [key, check] of Object.entries(STORED_VALUE_CHECKS)) {
    if (map.has(key) && !check(map.get(key))) {
      // The value is not logged: only its key, so a mistyped row is found without echoing data.
      logger.warn(
        { key },
        'Stored security setting has the wrong type or is out of range, using the fallback',
      );
    }
  }
}

function parseSecuritySettings(rows: { key: string; value: unknown }[]): ParsedSecurity {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  warnOnInvalidStoredValues(map);

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
    mfa: normalizeMfaConfig(withPrefix(map, 'security.mfa.')),
    passwordPolicy: normalizePasswordPolicy(withPrefix(map, 'security.password.')),
    sessionLifetimes: normalizeSessionLifetimes(withPrefix(map, 'security.session.')),
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
  } catch (err) {
    logger.warn(
      { err, key: 'security.*' },
      'loadSecuritySettings failed, using the cached value or default',
    );
    return cache;
  }
}

export async function getRecaptchaConfig(): Promise<RecaptchaConfig | null> {
  const parsed = await loadSecuritySettings();
  if (parsed == null) return null;
  return parsed.recaptcha.enabled ? parsed.recaptcha : null;
}

export async function getMfaConfig(): Promise<MfaConfig> {
  return (await readMfaConfig()).config;
}

/** The MFA switches, and whether they are the code defaults because no settings could be read. */
export interface MfaConfigReading {
  config: MfaConfig;
  fallback: boolean;
}

/**
 * The MFA switches for the sign-in gate. `fallback` is true when the settings
 * read failed with nothing cached, so the switches are the code defaults and
 * say nothing about what the admin chose.
 */
export async function readMfaConfig(): Promise<MfaConfigReading> {
  const parsed = await loadSecuritySettings();
  if (parsed == null) return { config: { ...MFA_FALLBACK }, fallback: true };
  return { config: parsed.mfa, fallback: false };
}

/** The password rules every password set checks. Login never checks them. */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  const parsed = await loadSecuritySettings();
  return parsed?.passwordPolicy ?? { ...DEFAULT_PASSWORD_POLICY };
}

/** Access and refresh token lifetimes, applied to tokens issued after a change. */
export async function getSessionLifetimes(): Promise<SessionLifetimes> {
  const parsed = await loadSecuritySettings();
  return parsed?.sessionLifetimes ?? { ...DEFAULT_SESSION_LIFETIMES };
}

export function clearSecuritySettingsCache(): void {
  cache = undefined;
  cachedAt = 0;
}
