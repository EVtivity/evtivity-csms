// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentContext } from './context.js';
import {
  countSitesWithPayoutAccount,
  ensureSitePaymentConfig,
  findSitePayoutAccount,
  payoutAccountIds,
  setPayoutAccountId,
  storeCreatedPayoutAccount,
  writePayoutAccountStatus,
} from './payout-account-records.js';
import { clearPaymentSettingsCache, getSitePaymentConfig } from './settings.js';
import type { PaymentProvider, PayoutAccountStatus } from './types.js';

/**
 * Site host payout accounts (plan P3.5 Part C). Payout accounts are Stripe
 * Connect accounts (Adyen has `payoutOnboarding: 'none'`, D-A2), so these
 * services use the Stripe provider whatever provider is active. The account
 * id is stored before any onboarding link exists (P4); a status read is
 * stored only when it is newer than the stored one (P5); a payout account
 * whose status is not `active` gets no destination charge (O5, fail closed).
 */

const PAYOUT_PROVIDER_ID = 'stripe';

/** Failure reason stored on the record of a payment refused for the payout account. */
export const PAYOUT_NOT_READY_FAILURE = 'Payout account not ready';
/** Decline reason shown to the driver. */
export const PAYOUT_NOT_READY_REASON = 'This site cannot accept card payments yet';

/** The payout provider; null when it cannot onboard accounts. Throws when it is not configured. */
async function payoutProvider(ctx: PaymentContext): Promise<PaymentProvider | null> {
  const provider = await ctx.registry.getPaymentProvider(PAYOUT_PROVIDER_ID);
  return provider.capabilities.payoutOnboarding === 'hosted_link' ? provider : null;
}

async function readStatus(
  provider: PaymentProvider,
  accountId: string,
): Promise<PayoutAccountStatus> {
  if (provider.getPayoutAccountStatus == null) {
    throw new Error(`Provider ${provider.id} cannot read payout accounts`);
  }
  return provider.getPayoutAccountStatus(accountId);
}

/** Reads the account and stores the status; returns it and the number of site configs updated. */
async function refreshAccount(
  provider: PaymentProvider,
  accountId: string,
): Promise<{ status: PayoutAccountStatus; updated: number }> {
  // The time the read started, so a read that overtakes this one wins.
  const checkedAt = new Date();
  const status = await readStatus(provider, accountId);
  const updated = await writePayoutAccountStatus(status, checkedAt);
  clearPaymentSettingsCache();
  return { status, updated };
}

export type CreatePayoutAccountOutcome =
  | { outcome: 'created'; accountId: string }
  /** The site already has a payout account (another request may have just stored it). */
  | { outcome: 'exists'; accountId: string }
  /** The payout provider cannot onboard accounts. */
  | { outcome: 'not_supported' };

/**
 * Creates the site host's connected account and stores its id on the site's
 * payment config (created disabled when the site has none). The idempotency
 * key is `payout_account_<siteId>_<config updatedAt ms>`: a retry of the
 * same request reuses the account Stripe made, and a re-creation after the
 * operator cleared the id (which changes `updatedAt`) gets a new one. When
 * a concurrent request stored an account first, that account wins. The
 * status is read once after the create (fail open: the first hold reads it
 * otherwise). Provider errors propagate (not configured, permission,
 * validation with Stripe's message).
 */
export async function createSitePayoutAccount(
  siteId: string,
  input: { displayName: string; contactEmail: string; country: string },
  ctx: PaymentContext,
): Promise<CreatePayoutAccountOutcome> {
  const provider = await payoutProvider(ctx);
  if (provider?.createPayoutAccount == null) return { outcome: 'not_supported' };

  await ensureSitePaymentConfig(siteId);
  const row = await findSitePayoutAccount(siteId);
  if (row == null) throw new Error(`Site payment config of ${siteId} not found`);
  if (row.accountId != null) return { outcome: 'exists', accountId: row.accountId };

  const { accountId } = await provider.createPayoutAccount({
    displayName: input.displayName,
    contactEmail: input.contactEmail,
    country: input.country,
    metadata: { evtivity_site_id: siteId },
    idempotencyKey: `payout_account_${siteId}_${String(row.updatedAt.getTime())}`,
  });

  if (!(await storeCreatedPayoutAccount(siteId, accountId))) {
    const winner = await findSitePayoutAccount(siteId);
    ctx.logger.warn(
      { siteId, accountId, storedAccountId: winner?.accountId },
      'Another payout account was stored for the site first; the new account is unused',
    );
    return { outcome: 'exists', accountId: winner?.accountId ?? accountId };
  }
  clearPaymentSettingsCache();

  try {
    await refreshAccount(provider, accountId);
  } catch (err) {
    ctx.logger.warn({ err, siteId, accountId }, 'Payout account status read failed after create');
  }
  return { outcome: 'created', accountId };
}

export type PayoutOnboardingLinkOutcome =
  | { outcome: 'link'; url: string; expiresAt: Date }
  /** The stored status is `active`: nothing to onboard. */
  | { outcome: 'active' }
  | { outcome: 'no_account' }
  | { outcome: 'not_supported' };

/**
 * A fresh provider-hosted onboarding link for the site's payout account.
 * The link is single use and expires after minutes, so it is minted on each
 * visit of the EVtivity onboarding page and never emailed (O3, O4).
 */
export async function createSitePayoutOnboardingLink(
  siteId: string,
  urls: { refreshUrl: string; returnUrl: string },
  ctx: PaymentContext,
): Promise<PayoutOnboardingLinkOutcome> {
  const row = await findSitePayoutAccount(siteId);
  if (row?.accountId == null) return { outcome: 'no_account' };
  if (row.status === 'active') return { outcome: 'active' };
  const provider = await payoutProvider(ctx);
  if (provider?.createPayoutOnboardingLink == null) return { outcome: 'not_supported' };
  const link = await provider.createPayoutOnboardingLink({ accountId: row.accountId, ...urls });
  return { outcome: 'link', ...link };
}

/**
 * The operator's manual account id (an account onboarded in Stripe), or null
 * to clear it. A changed id forgets the old status and is read at once (fail
 * open, warn: the first hold reads it otherwise). Returns whether the id
 * changed; false also when the site has no payment config.
 */
export async function setSitePayoutAccountId(
  siteId: string,
  accountId: string | null,
  ctx: PaymentContext,
): Promise<boolean> {
  const id = accountId == null || accountId.trim() === '' ? null : accountId.trim();
  const changed = await setPayoutAccountId(siteId, id);
  if (!changed) return false;
  clearPaymentSettingsCache();
  if (id != null) {
    try {
      const provider = await payoutProvider(ctx);
      if (provider != null) await refreshAccount(provider, id);
    } catch (err) {
      ctx.logger.warn({ err, siteId, accountId: id }, 'Payout account status read failed');
    }
  }
  return true;
}

/**
 * Reads the site's payout account from the provider and stores the status.
 * Null when the site has no account. Provider errors propagate.
 */
export async function refreshSitePayoutAccount(
  siteId: string,
  ctx: PaymentContext,
): Promise<PayoutAccountStatus | null> {
  const row = await findSitePayoutAccount(siteId);
  if (row?.accountId == null) return null;
  const provider = await payoutProvider(ctx);
  if (provider == null) return null;
  return (await refreshAccount(provider, row.accountId)).status;
}

/**
 * Refreshes every site config that uses the account (`account.updated`).
 * Returns the number of site configs updated; an account no site uses (the
 * platform's other Connect accounts) is not read.
 */
export async function refreshPayoutAccountById(
  accountId: string,
  ctx: PaymentContext,
): Promise<number> {
  if ((await countSitesWithPayoutAccount(accountId)) === 0) return 0;
  const provider = await payoutProvider(ctx);
  if (provider == null) return 0;
  return (await refreshAccount(provider, accountId)).updated;
}

/**
 * Refreshes every payout account in use (the daily sync). One account's
 * failure is logged at warn and the others continue (P9).
 */
export async function refreshAllPayoutAccounts(
  ctx: PaymentContext,
): Promise<{ total: number; refreshed: number; failed: number }> {
  const ids = await payoutAccountIds();
  if (ids.length === 0) return { total: 0, refreshed: 0, failed: 0 };
  const provider = await payoutProvider(ctx);
  if (provider == null) return { total: ids.length, refreshed: 0, failed: 0 };
  let refreshed = 0;
  let failed = 0;
  for (const accountId of ids) {
    try {
      await refreshAccount(provider, accountId);
      refreshed++;
    } catch (err) {
      failed++;
      ctx.logger.warn({ err, accountId }, 'Payout account status sync failed');
    }
  }
  return { total: ids.length, refreshed, failed };
}

export type PayoutReadiness = 'none' | 'ready' | 'not_ready';

/**
 * Whether new destination charges may go to the enabled site config's
 * payout account: `none` without an account (the platform is charged),
 * `ready` when its status is `active`, else `not_ready` (O5, fail closed).
 * An account never read is read once; a failed read is `not_ready`.
 */
export async function sitePayoutReadiness(
  siteId: string,
  ctx: PaymentContext,
): Promise<PayoutReadiness> {
  const site = await getSitePaymentConfig(siteId);
  if (site?.payoutAccountId == null) return 'none';
  if (site.payoutAccountStatus === 'active') return 'ready';
  if (site.payoutAccountStatus != null) return 'not_ready';
  try {
    const provider = await payoutProvider(ctx);
    if (provider == null) return 'not_ready';
    const { status } = await refreshAccount(provider, site.payoutAccountId);
    return status.state === 'active' ? 'ready' : 'not_ready';
  } catch (err) {
    ctx.logger.warn(
      { err, siteId, accountId: site.payoutAccountId },
      'Payout account status read failed; refusing destination charges until it succeeds',
    );
    return 'not_ready';
  }
}
