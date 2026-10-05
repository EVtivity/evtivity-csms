// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { AppError, dispatchSystemNotification } from '@evtivity/lib';
import { client, db, siteAuditLog, sitePayoutInvites, sites, writeAudit } from '@evtivity/database';
import { findSitePayoutAccount } from '@evtivity/payments';
import { generateUserToken, hashUserToken } from '../lib/user-token.js';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from '../lib/config.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

// The only writer of `site_payout_invites` (plan P3.5 Part C, O4). The
// operator creates a 7-day EVtivity link for the site host, to copy or to
// email to the site contact. The link opens a public portal page that mints
// a fresh Stripe Account Link on each visit; the Stripe link itself is never
// emailed, because it is single use and expires after minutes. Only the
// SHA-256 of the token is stored, as for portal invites.

const INVITE_TTL_DAYS = 7;
const AUDIT_TABLE = { table: siteAuditLog, idColumn: 'site_id' };

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface PayoutInviteContext {
  actor: AuditActorInfo;
  log: Logger;
}

export interface PayoutInvite {
  url: string;
  expiresAt: Date;
  /** The address the link was emailed to, or null when it was only created. */
  sentTo: string | null;
}

const invalidToken = (): AppError =>
  new AppError('Invalid or expired onboarding link', 400, 'INVALID_TOKEN');

/** The public onboarding page of a token (also the Stripe `refresh_url`). */
export function payoutOnboardingUrl(rawToken: string): string {
  return `${config.PORTAL_URL}/payout-onboarding?token=${encodeURIComponent(rawToken)}`;
}

/** Where Stripe sends the site host back after onboarding (the Stripe `return_url`). */
export function payoutOnboardingReturnUrl(rawToken: string): string {
  return `${config.PORTAL_URL}/payout-onboarding/return?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Creates the site's onboarding link and, with `send: 'email'`, emails it
 * to the site contact (`site.PayoutOnboarding`, fail open). A new link
 * revokes the site's open links, so only the newest works. Throws 404
 * SITE_NOT_FOUND, 409 PAYOUT_ACCOUNT_NOT_READY without a payout account (the
 * operator creates one first), 400 EMAIL_REQUIRED for an email without a
 * site contact email.
 */
export async function createPayoutInvite(
  siteId: string,
  options: { send: 'email' | 'none' },
  ctx: PayoutInviteContext,
): Promise<PayoutInvite> {
  const [site] = await db
    .select({
      id: sites.id,
      name: sites.name,
      contactName: sites.contactName,
      contactEmail: sites.contactEmail,
    })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (site == null) throw new AppError('Site not found', 404, 'SITE_NOT_FOUND');

  const account = await findSitePayoutAccount(siteId);
  if (account?.accountId == null) {
    throw new AppError(
      'The site has no payout account; create one first',
      409,
      'PAYOUT_ACCOUNT_NOT_READY',
    );
  }
  const email = site.contactEmail != null && site.contactEmail !== '' ? site.contactEmail : null;
  if (options.send === 'email' && email == null) {
    throw new AppError('The site has no contact email address', 400, 'EMAIL_REQUIRED');
  }
  const sentTo = options.send === 'email' ? email : null;

  const { raw, hash } = generateUserToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.transaction(async (tx) => {
    await tx
      .update(sitePayoutInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(sitePayoutInvites.siteId, siteId), isNull(sitePayoutInvites.revokedAt)));
    await tx.insert(sitePayoutInvites).values({
      siteId,
      tokenHash: hash,
      sentTo,
      createdByUserId: ctx.actor.actorUserId,
      expiresAt,
    });
  });
  const url = payoutOnboardingUrl(raw);

  if (sentTo != null) {
    try {
      await dispatchSystemNotification(
        client,
        'site.PayoutOnboarding',
        { email: sentTo, firstName: site.contactName ?? undefined },
        {
          siteName: site.name,
          contactName: site.contactName ?? '',
          onboardingUrl: url,
          expiresInDays: INVITE_TTL_DAYS,
        },
        ALL_TEMPLATES_DIRS,
      );
    } catch (err) {
      ctx.log.warn({ err, siteId }, 'Payout onboarding email failed');
    }
  }

  await writeAudit(
    AUDIT_TABLE,
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'payment_config_changed',
      ...ctx.actor,
      after: { payoutOnboardingInvite: { expiresAt, sentTo } },
      notes: 'Payout onboarding link created',
    },
    db,
    ctx.log,
  );

  return { url, expiresAt, sentTo };
}

/**
 * The site of an open (not revoked, not expired) onboarding link, and marks
 * the link used. 400 INVALID_TOKEN otherwise, the same for every reason so
 * the answer reveals nothing about the site.
 */
export async function resolvePayoutInvite(rawToken: string): Promise<{ siteId: string }> {
  const now = new Date();
  const [invite] = await db
    .update(sitePayoutInvites)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(sitePayoutInvites.tokenHash, hashUserToken(rawToken)),
        isNull(sitePayoutInvites.revokedAt),
        gt(sitePayoutInvites.expiresAt, now),
      ),
    )
    .returning({ siteId: sitePayoutInvites.siteId });
  if (invite == null) throw invalidToken();
  return { siteId: invite.siteId };
}

/**
 * Revokes the site's open links: when the payout account becomes active or
 * its id changes. Returns the number revoked.
 */
export async function revokePayoutInvites(siteId: string): Promise<number> {
  const rows = await db
    .update(sitePayoutInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(sitePayoutInvites.siteId, siteId), isNull(sitePayoutInvites.revokedAt)))
    .returning({ id: sitePayoutInvites.id });
  return rows.length;
}

/** The site's newest open link, for the operator's view (never the token). */
export async function openPayoutInvite(
  siteId: string,
): Promise<{ expiresAt: Date; sentTo: string | null; lastUsedAt: Date | null } | null> {
  const [invite] = await db
    .select({
      expiresAt: sitePayoutInvites.expiresAt,
      sentTo: sitePayoutInvites.sentTo,
      lastUsedAt: sitePayoutInvites.lastUsedAt,
    })
    .from(sitePayoutInvites)
    .where(
      and(
        eq(sitePayoutInvites.siteId, siteId),
        isNull(sitePayoutInvites.revokedAt),
        gt(sitePayoutInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sitePayoutInvites.createdAt))
    .limit(1);
  return invite ?? null;
}
