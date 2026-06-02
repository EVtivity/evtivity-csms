// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { createLogger, decryptString } from '@evtivity/lib';
import type { PkiProvider } from './pki-provider.js';
import { HubjectProvider } from './hubject-provider.js';
import { ManualProvider } from './manual-provider.js';
import { config } from '../../lib/config.js';

const logger = createLogger('pki-provider-factory');

const PROVIDER_KEYS = [
  'pnc.provider',
  'pnc.hubject.baseUrl',
  'pnc.hubject.clientId',
  'pnc.hubject.clientSecretEnc',
  'pnc.hubject.tokenUrl',
];

interface ProviderCache {
  type: string;
  instance: PkiProvider;
  // Latest settings.updated_at across the rows that contributed to the
  // current instance. Used to detect any operator change since we built
  // the provider, including secret rotations / baseUrl swaps where the
  // provider type itself stayed the same.
  latestUpdatedAtMs: number;
}

let cachedProvider: ProviderCache | null = null;

function getEncryptionKey(): string {
  return config.SETTINGS_ENCRYPTION_KEY;
}

export async function getPkiProvider(): Promise<PkiProvider> {
  // Always query settings to detect operator changes. The HubjectProvider
  // holds an OAuth2 token cache so the previous in-process cache existed
  // to avoid losing that token across calls — we preserve that by reusing
  // the same instance whenever none of the PnC settings rows have changed
  // since we built it. The earlier logic only checked TTL (60s stale
  // window) and provider-type match, so a secret rotation or baseUrl swap
  // wouldn't reach OCPP handlers until the TTL expired.
  const rows = await client`
    SELECT key, value, updated_at FROM settings
    WHERE key IN ${client(PROVIDER_KEYS)}
  `;

  const configMap = new Map<string, string>();
  let latestUpdatedAtMs = 0;
  for (const row of rows) {
    const val = row.value as unknown;
    configMap.set(row.key as string, typeof val === 'string' ? val : '');
    const ts = row.updated_at as Date | string;
    const ms = typeof ts === 'string' ? Date.parse(ts) : ts.getTime();
    if (ms > latestUpdatedAtMs) latestUpdatedAtMs = ms;
  }

  const providerType = configMap.get('pnc.provider') ?? 'manual';

  if (
    cachedProvider != null &&
    cachedProvider.type === providerType &&
    cachedProvider.latestUpdatedAtMs === latestUpdatedAtMs
  ) {
    return cachedProvider.instance;
  }

  let instance: PkiProvider;

  if (providerType === 'hubject') {
    const clientSecretEnc = configMap.get('pnc.hubject.clientSecretEnc') ?? '';
    let clientSecret = '';
    if (clientSecretEnc !== '') {
      try {
        clientSecret = decryptString(clientSecretEnc, getEncryptionKey());
      } catch {
        logger.error('Failed to decrypt Hubject client secret');
      }
    }

    instance = new HubjectProvider({
      baseUrl: configMap.get('pnc.hubject.baseUrl') ?? '',
      clientId: configMap.get('pnc.hubject.clientId') ?? '',
      clientSecret,
      tokenUrl: configMap.get('pnc.hubject.tokenUrl') ?? '',
    });

    logger.info('Hubject PKI provider initialized');
  } else {
    instance = new ManualProvider();
    logger.info('Manual PKI provider initialized');
  }

  cachedProvider = { type: providerType, instance, latestUpdatedAtMs };
  return instance;
}
