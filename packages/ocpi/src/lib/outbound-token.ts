// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, ocpiCredentialsTokens } from '@evtivity/database';
import { createLogger, decryptString } from '@evtivity/lib';
import { config } from './config.js';

const logger = createLogger('ocpi-outbound-token');

function getEncryptionKey(): string {
  return config.SETTINGS_ENCRYPTION_KEY;
}

export async function getOutboundToken(partnerId: string): Promise<string | null> {
  const [row] = await db
    .select({ outboundTokenEnc: ocpiCredentialsTokens.outboundTokenEnc })
    .from(ocpiCredentialsTokens)
    .where(
      and(
        eq(ocpiCredentialsTokens.partnerId, partnerId),
        eq(ocpiCredentialsTokens.direction, 'received'),
        eq(ocpiCredentialsTokens.isActive, true),
      ),
    )
    .limit(1);

  if (row?.outboundTokenEnc == null) {
    return null;
  }

  // A corrupted ciphertext or a SETTINGS_ENCRYPTION_KEY rotation without
  // re-encrypting the column would otherwise throw out of every push,
  // pull, and command-callback path, taking the whole pipeline down for
  // one bad partner. Log and return null so the caller can fail-fast on
  // missing auth without crashing.
  try {
    return decryptString(row.outboundTokenEnc, getEncryptionKey());
  } catch (err: unknown) {
    logger.error(
      { partnerId, err: err instanceof Error ? err.message : String(err) },
      'Failed to decrypt outbound token; treating as missing',
    );
    return null;
  }
}
