// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users } from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';

/**
 * The stored UI language of a CSMS user, for text the server writes for that
 * user (a CSV label). Fail-open: a failed read answers null, which callers
 * read as English, since a label never stops the request.
 */
export async function userLanguage(userId: string, log: ServiceLogger): Promise<string | null> {
  try {
    const [row] = await db
      .select({ language: users.language })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.language ?? null;
  } catch (err) {
    log.warn({ err, userId }, 'Reading the user language failed; writing English');
    return null;
  }
}
