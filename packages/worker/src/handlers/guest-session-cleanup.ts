// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, lte, sql } from 'drizzle-orm';
import { db, guestSessions } from '@evtivity/database';
import type { Logger } from 'pino';
import { getStripeConfig, cancelPaymentIntent } from '@evtivity/api/src/services/stripe.service.js';

export async function guestSessionCleanupHandler(log: Logger): Promise<void> {
  const expired = await db
    .select()
    .from(guestSessions)
    .where(
      and(
        sql`${guestSessions.status} IN ('pending_payment', 'payment_authorized')`,
        lte(guestSessions.expiresAt, new Date()),
      ),
    );

  for (const gs of expired) {
    try {
      if (gs.stripePaymentIntentId != null) {
        const config = await getStripeConfig(null);
        if (config != null) {
          await cancelPaymentIntent(config, gs.stripePaymentIntentId);
        }
      }
      await db
        .update(guestSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(guestSessions.id, gs.id));
    } catch (err: unknown) {
      log.error({ guestSessionId: gs.id, error: err }, 'Failed to expire guest session');
    }
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'Expired guest sessions cleaned up');
  }
}
