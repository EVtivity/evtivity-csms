// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { inArray } from 'drizzle-orm';
import { db, settings, settingAuditLog, writeAudit } from '@evtivity/database';
import { getAuditActor } from './audit-actor.js';
import { clearPaymentCaches } from './payments.js';
import { assertPaymentProviderWritable } from './provider-switch.js';

/**
 * The one writer of payment settings (`payments.*`, `stripe.*`, `adyen.*`, `simulated.*`)
 * for the payment routes: upserts every pair in one transaction, clears the
 * payment caches, and audits each key whose value changed (fail-open, P9).
 * `*Enc` values arrive already encrypted. A failed write throws. Selecting a
 * guarded provider (`payments.provider`) runs the provider-switch guard first
 * and throws PaymentProviderUpgradePendingError without writing anything.
 */
export async function writePaymentSettings(
  request: FastifyRequest,
  pairs: Array<{ key: string; value: unknown }>,
): Promise<void> {
  for (const { key, value } of pairs) await assertPaymentProviderWritable(key, value);
  if (pairs.length === 0) {
    clearPaymentCaches();
    return;
  }
  const keys = pairs.map((p) => p.key);
  const beforeRows = await db.select().from(settings).where(inArray(settings.key, keys));
  const before = new Map<string, unknown>(beforeRows.map((row) => [row.key, row.value]));

  await db.transaction(async (tx) => {
    for (const { key, value } of pairs) {
      await tx
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    }
  });

  clearPaymentCaches();

  const actor = getAuditActor(request);
  await Promise.allSettled(
    pairs
      .filter(({ key, value }) => before.get(key) !== value)
      .map(({ key, value }) =>
        writeAudit(
          { table: settingAuditLog, idColumn: 'setting_key' },
          {
            entityId: key,
            entityIdSnapshot: key,
            action: 'updated',
            ...actor,
            before: { key, value: before.get(key) },
            after: { key, value },
          },
          db,
          request.log,
        ),
      ),
  );
}
