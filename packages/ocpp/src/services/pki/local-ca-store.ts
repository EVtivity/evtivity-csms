// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { createLogger, decryptString } from '@evtivity/lib';
import { config } from '../../lib/config.js';
import { parseLocalContractCa, type LocalContractCa } from './local-contract-ca.js';

const logger = createLogger('local-contract-ca');

const TTL_MS = 60_000;

let cached: { ca: LocalContractCa | null; loadedAt: number } | null = null;

/**
 * The local contract CA from the encrypted setting pnc.local.caEnc, or null
 * when none was created. Cached for 60 s; the API publishes
 * `{ cache: 'pkiCaCertificates' }` on cache_invalidate after creating one.
 */
export async function getLocalContractCa(): Promise<LocalContractCa | null> {
  if (cached != null && Date.now() - cached.loadedAt < TTL_MS) return cached.ca;
  const rows = await client`SELECT value FROM settings WHERE key = 'pnc.local.caEnc'`;
  const value = rows[0]?.value as unknown;
  let ca: LocalContractCa | null = null;
  if (typeof value === 'string' && value !== '') {
    try {
      ca = parseLocalContractCa(decryptString(value, config.SETTINGS_ENCRYPTION_KEY));
      if (ca == null) logger.error('Stored local contract CA is not a valid bundle');
    } catch (err) {
      logger.error({ err }, 'Failed to decrypt the local contract CA');
    }
  }
  cached = { ca, loadedAt: Date.now() };
  return ca;
}

export function clearLocalContractCaCache(): void {
  cached = null;
}
