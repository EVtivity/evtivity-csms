// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

export interface AttestationConfig {
  enabled: boolean;
  ios: { teamId: string; bundleId: string; environment: 'development' | 'production' };
  android: { cloudProjectNumber: string; packageName: string; serviceAccountEnc: string };
}

let cache: AttestationConfig | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

function str(map: Map<string, unknown>, key: string): string {
  const v = map.get(key);
  return typeof v === 'string' ? v : '';
}

function parse(rows: { key: string; value: unknown }[]): AttestationConfig {
  const map = new Map<string, unknown>();
  for (const row of rows) map.set(row.key, row.value);
  const env = str(map, 'mobile.attestation.ios.environment');
  return {
    enabled: map.get('mobile.attestation.enabled') === true,
    ios: {
      teamId: str(map, 'mobile.attestation.ios.teamId'),
      bundleId: str(map, 'mobile.attestation.ios.bundleId'),
      environment: env === 'production' ? 'production' : 'development',
    },
    android: {
      cloudProjectNumber: str(map, 'mobile.attestation.android.cloudProjectNumber'),
      packageName: str(map, 'mobile.attestation.android.packageName'),
      serviceAccountEnc: str(map, 'mobile.attestation.android.serviceAccountEnc'),
    },
  };
}

const FALLBACK: AttestationConfig = {
  enabled: false,
  ios: { teamId: '', bundleId: '', environment: 'development' },
  android: { cloudProjectNumber: '', packageName: '', serviceAccountEnc: '' },
};

export async function getAttestationConfig(): Promise<AttestationConfig> {
  const now = Date.now();
  if (cache != null && now - cachedAt < TTL_MS) return cache;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'mobile.attestation.%'));
    cache = parse(rows);
    cachedAt = now;
    return cache;
  } catch {
    return cache ?? FALLBACK;
  }
}

export function clearAttestationConfigCache(): void {
  cache = undefined;
  cachedAt = 0;
}
