// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import { createLogger, decryptString } from '@evtivity/lib';
import type { PkiProvider } from './pki-provider.js';
import { HubjectProvider } from './hubject-provider.js';
import { ManualProvider } from './manual-provider.js';
import { config } from '../../lib/config.js';

const logger = createLogger('pki-provider-factory');

let cachedProvider: { type: string; instance: PkiProvider } | null = null;
let settingsCachedAt = 0;
const SETTINGS_TTL_MS = 60_000;

function getEncryptionKey(): string {
  return config.SETTINGS_ENCRYPTION_KEY;
}

function getDatabaseUrl(): string {
  return config.DATABASE_URL;
}

export async function getPkiProvider(): Promise<PkiProvider> {
  const now = Date.now();
  if (cachedProvider != null && now - settingsCachedAt < SETTINGS_TTL_MS) {
    return cachedProvider.instance;
  }

  const databaseUrl = getDatabaseUrl();
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [providerRow] = await sql`
      SELECT value FROM settings WHERE key = 'pnc.provider'
    `;
    const providerType =
      providerRow != null && typeof providerRow.value === 'string' ? providerRow.value : 'manual';

    if (cachedProvider != null && cachedProvider.type === providerType) {
      settingsCachedAt = now;
      return cachedProvider.instance;
    }

    let instance: PkiProvider;

    if (providerType === 'hubject') {
      const rows = await sql`
        SELECT key, value FROM settings
        WHERE key IN ('pnc.hubject.baseUrl', 'pnc.hubject.clientId', 'pnc.hubject.clientSecretEnc', 'pnc.hubject.tokenUrl')
      `;

      const configMap = new Map<string, string>();
      for (const row of rows) {
        const val = row.value as unknown;
        configMap.set(row.key as string, typeof val === 'string' ? val : '');
      }

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
      instance = new ManualProvider(databaseUrl);
      logger.info('Manual PKI provider initialized');
    }

    cachedProvider = { type: providerType, instance };
    settingsCachedAt = now;
    return instance;
  } finally {
    await sql.end();
  }
}
