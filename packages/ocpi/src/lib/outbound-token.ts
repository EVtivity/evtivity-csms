// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, ocpiCredentialsTokens } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
import { config } from './config.js';

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

  return decryptString(row.outboundTokenEnc, getEncryptionKey());
}
