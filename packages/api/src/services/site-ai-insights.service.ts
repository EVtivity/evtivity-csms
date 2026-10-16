// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-site AI insight suppression. The only writer of the
 * `sites.ai_insights_suppressed_*` columns (P3), the site counterpart of
 * `station-ai-insights.service.ts`. While a site is suppressed (until a date,
 * or until resumed) every station of the site counts as suppressed, stations
 * added later included, and the site gets no site-level insight
 * (`stationInsightsSuppressedSql`, `siteInsightsSuppressedSql`); the end date
 * passing resumes them with no action. Suppressing closes the open insights
 * of the site and its stations `dismissed` with the reason and expires their
 * waiting actions, through the insight and action services. Audited in the
 * site history.
 */

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, sites, siteAuditLog, users, writeAudit } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { dismissSiteInsights } from '@evtivity/services/ai-insight.service';
import { expireSiteAiProposals } from '@evtivity/services/ai-proposal.service';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import type { AiInsightSuppression, SuppressResult } from './station-ai-insights.service.js';

async function current(siteId: string): Promise<AiInsightSuppression | null> {
  const [row] = await db
    .select({
      suppressedAt: sites.aiInsightsSuppressedAt,
      suppressedUntil: sites.aiInsightsSuppressedUntil,
      suppressedBy: sites.aiInsightsSuppressedBy,
      reason: sites.aiInsightsSuppressedReason,
    })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (row == null) return null;
  const [user] =
    row.suppressedBy == null
      ? []
      : await db
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, row.suppressedBy));
  const name = user == null ? null : `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return { ...row, suppressedByName: name === '' ? null : name };
}

async function auditChange(
  siteId: string,
  actor: AuditActorInfo,
  before: AiInsightSuppression,
  after: Record<string, unknown>,
  notes: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'updated',
      ...actor,
      before: {
        aiInsightsSuppressedAt: before.suppressedAt,
        aiInsightsSuppressedUntil: before.suppressedUntil,
        aiInsightsSuppressedReason: before.reason,
      },
      after,
      notes,
    },
    db,
    log,
  );
}

/**
 * Suppresses the AI insights of the site and all its stations from now until
 * `until` (null: until resumed). Null when the site is unknown.
 */
export async function suppressSiteAiInsights(
  siteId: string,
  input: { reason: string; until: Date | null },
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<SuppressResult | null> {
  const before = await current(siteId);
  if (before == null) return null;
  await db
    .update(sites)
    .set({
      aiInsightsSuppressedAt: new Date(),
      aiInsightsSuppressedUntil: input.until,
      aiInsightsSuppressedBy: actor.actorUserId,
      aiInsightsSuppressedReason: input.reason,
    })
    .where(eq(sites.id, siteId));
  await auditChange(
    siteId,
    actor,
    before,
    {
      aiInsightsSuppressedUntil: input.until,
      aiInsightsSuppressedReason: input.reason,
    },
    'AI insights suppressed',
    log,
  );
  // Waiting actions end expired with their insight; then the open insights.
  const actionsExpired = await expireSiteAiProposals(
    siteId,
    input.reason,
    { actor: actor.actor, actorUserId: actor.actorUserId, actorLabel: actor.actorLabel },
    log,
  );
  const dismissed = await dismissSiteInsights(
    siteId,
    input.reason,
    { actor: actor.actor, actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId },
    getPubSub(),
  );
  const after = await current(siteId);
  if (after == null) return null;
  return { ...after, insightsDismissed: dismissed.length, actionsExpired };
}

/** Resumes the AI insights of the site. Null when the site is unknown. */
export async function resumeSiteAiInsights(
  siteId: string,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<AiInsightSuppression | null> {
  const before = await current(siteId);
  if (before == null) return null;
  if (before.suppressedAt == null) return before;
  await db
    .update(sites)
    .set({
      aiInsightsSuppressedAt: null,
      aiInsightsSuppressedUntil: null,
      aiInsightsSuppressedBy: null,
      aiInsightsSuppressedReason: null,
    })
    .where(eq(sites.id, siteId));
  await auditChange(
    siteId,
    actor,
    before,
    { aiInsightsSuppressedAt: null, aiInsightsSuppressedUntil: null },
    'AI insights resumed',
    log,
  );
  return current(siteId);
}
