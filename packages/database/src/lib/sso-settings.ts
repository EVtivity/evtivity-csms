// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { decryptString } from '@evtivity/lib';

export interface SsoConfig {
  enabled: boolean;
  provider: string;
  entryPoint: string;
  issuer: string;
  cert: string;
  autoProvision: boolean;
  defaultRoleId: string;
  attributeMapping: Record<string, string>;
  allowedDomains: string[];
}

let ssoCache: SsoConfig | null | undefined;
let ssoCachedAt = 0;

const TTL_MS = 60_000;

function getEncryptionKey(): string {
  const key = process.env['SETTINGS_ENCRYPTION_KEY'];
  if (key == null || key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

function parseSsoSettings(rows: { key: string; value: unknown }[]): SsoConfig | null {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  const enabled = map.get('sso.enabled') === true;
  if (!enabled) return null;

  const certEnc =
    typeof map.get('sso.certEnc') === 'string' ? (map.get('sso.certEnc') as string) : '';

  let cert = '';
  if (certEnc !== '') {
    try {
      cert = decryptString(certEnc, getEncryptionKey());
    } catch {
      cert = '';
    }
  }

  let attributeMapping: Record<string, string> = {
    email: 'email',
    firstName: 'firstName',
    lastName: 'lastName',
  };
  const rawMapping = map.get('sso.attributeMapping');
  if (typeof rawMapping === 'string') {
    try {
      attributeMapping = JSON.parse(rawMapping) as Record<string, string>;
    } catch {
      // keep default
    }
  } else if (typeof rawMapping === 'object' && rawMapping !== null) {
    attributeMapping = rawMapping as Record<string, string>;
  }

  let allowedDomains: string[] = [];
  const rawDomains = map.get('sso.allowedDomains');
  if (typeof rawDomains === 'string' && rawDomains !== '') {
    allowedDomains = rawDomains
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d !== '');
  } else if (Array.isArray(rawDomains)) {
    allowedDomains = (rawDomains as string[]).map((d) => d.toLowerCase());
  }

  return {
    enabled: true,
    provider:
      typeof map.get('sso.provider') === 'string' ? (map.get('sso.provider') as string) : '',
    entryPoint:
      typeof map.get('sso.entryPoint') === 'string' ? (map.get('sso.entryPoint') as string) : '',
    issuer:
      typeof map.get('sso.issuer') === 'string'
        ? (map.get('sso.issuer') as string)
        : 'evtivity-csms',
    cert,
    autoProvision: map.get('sso.autoProvision') === true,
    defaultRoleId:
      typeof map.get('sso.defaultRoleId') === 'string'
        ? (map.get('sso.defaultRoleId') as string)
        : '',
    attributeMapping,
    allowedDomains,
  };
}

export async function getSsoConfig(): Promise<SsoConfig | null> {
  const now = Date.now();
  if (ssoCache !== undefined && now - ssoCachedAt < TTL_MS) {
    return ssoCache;
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'sso.%'));
    ssoCache = parseSsoSettings(rows);
    ssoCachedAt = now;
    return ssoCache;
  } catch {
    return ssoCache ?? null;
  }
}

export function clearSsoSettingsCache(): void {
  ssoCache = undefined;
  ssoCachedAt = 0;
}
