// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db, sitePaymentConfigs } from '@evtivity/database';
import type { PayoutAccountState, PayoutAccountStatus } from './types.js';

/**
 * The only writer of a site's payout account columns
 * (`site_payment_configs.payout_account_id`, `payout_account_status`,
 * `payout_account_details`, `payout_account_checked_at`; plan P3.5 P3). The
 * service in `payout-accounts.ts` decides; this module reads and writes.
 */

export interface SitePayoutAccountRow {
  configId: number;
  siteId: string;
  accountId: string | null;
  status: PayoutAccountState | null;
  details: unknown;
  checkedAt: Date | null;
  /** Changes when the operator edits the config or the account id, never on a status write. */
  updatedAt: Date;
}

/** What `payout_account_details` holds: the status without the id and the state. */
export type PayoutAccountDetails = Omit<PayoutAccountStatus, 'accountId' | 'state'>;

const rowFields = () => ({
  configId: sitePaymentConfigs.id,
  siteId: sitePaymentConfigs.siteId,
  accountId: sitePaymentConfigs.payoutAccountId,
  status: sitePaymentConfigs.payoutAccountStatus,
  details: sitePaymentConfigs.payoutAccountDetails,
  checkedAt: sitePaymentConfigs.payoutAccountCheckedAt,
  updatedAt: sitePaymentConfigs.updatedAt,
});

/** The site's payment config row with its payout account, enabled or not. */
export async function findSitePayoutAccount(siteId: string): Promise<SitePayoutAccountRow | null> {
  const [row] = await db
    .select(rowFields())
    .from(sitePaymentConfigs)
    .where(eq(sitePaymentConfigs.siteId, siteId));
  if (row == null) return null;
  return {
    ...row,
    accountId: row.accountId === '' ? null : row.accountId,
    status: row.status as PayoutAccountState | null,
  };
}

/**
 * Creates the site's payment config, disabled, when it has none, so a
 * payout account can be stored before the operator enables payments there.
 */
export async function ensureSitePaymentConfig(siteId: string): Promise<void> {
  await db
    .insert(sitePaymentConfigs)
    .values({ siteId, isEnabled: false })
    .onConflictDoNothing({ target: sitePaymentConfigs.siteId });
}

const CLEARED_STATUS = {
  payoutAccountStatus: null,
  payoutAccountDetails: null,
  payoutAccountCheckedAt: null,
} as const;

/**
 * Stores a just-created account on a site that has none. False when another
 * request stored one first (that account wins).
 */
export async function storeCreatedPayoutAccount(
  siteId: string,
  accountId: string,
): Promise<boolean> {
  const rows = await db
    .update(sitePaymentConfigs)
    .set({ payoutAccountId: accountId, ...CLEARED_STATUS, updatedAt: new Date() })
    .where(and(eq(sitePaymentConfigs.siteId, siteId), isNull(sitePaymentConfigs.payoutAccountId)))
    .returning({ id: sitePaymentConfigs.id });
  return rows.length > 0;
}

/**
 * Sets (or with null, clears) the site's account id. A changed id forgets the
 * old status, so the new account is read before its first use. False when the
 * id did not change or the site has no payment config.
 */
export async function setPayoutAccountId(
  siteId: string,
  accountId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(sitePaymentConfigs)
    .set({ payoutAccountId: accountId, ...CLEARED_STATUS, updatedAt: new Date() })
    .where(
      and(
        eq(sitePaymentConfigs.siteId, siteId),
        sql`${sitePaymentConfigs.payoutAccountId} IS DISTINCT FROM CAST(${accountId} AS varchar)`,
      ),
    )
    .returning({ id: sitePaymentConfigs.id });
  return rows.length > 0;
}

/**
 * Stores a status read on every site config with that account. `checkedAt`
 * is when the read started: a read older than the stored one is dropped, so
 * a slow refresh never overwrites a newer webhook or cron read (P5).
 * Returns the number of site configs updated.
 */
export async function writePayoutAccountStatus(
  status: PayoutAccountStatus,
  checkedAt: Date,
): Promise<number> {
  const details: PayoutAccountDetails = {
    capabilities: status.capabilities,
    detailsSubmitted: status.detailsSubmitted,
    requirementsDue: status.requirementsDue,
    disabledReason: status.disabledReason,
  };
  const rows = await db
    .update(sitePaymentConfigs)
    .set({
      payoutAccountStatus: status.state,
      payoutAccountDetails: details,
      payoutAccountCheckedAt: checkedAt,
    })
    .where(
      and(
        eq(sitePaymentConfigs.payoutAccountId, status.accountId),
        or(
          isNull(sitePaymentConfigs.payoutAccountCheckedAt),
          lte(sitePaymentConfigs.payoutAccountCheckedAt, checkedAt),
        ),
      ),
    )
    .returning({ id: sitePaymentConfigs.id });
  return rows.length;
}

/** Number of site configs that use the account. */
export async function countSitesWithPayoutAccount(accountId: string): Promise<number> {
  const rows = await db
    .select({ id: sitePaymentConfigs.id })
    .from(sitePaymentConfigs)
    .where(eq(sitePaymentConfigs.payoutAccountId, accountId));
  return rows.length;
}

/** Every payout account id in use, once. */
export async function payoutAccountIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: sitePaymentConfigs.payoutAccountId })
    .from(sitePaymentConfigs)
    .where(isNotNull(sitePaymentConfigs.payoutAccountId));
  return rows.flatMap((r) => (r.accountId != null ? [r.accountId] : []));
}
