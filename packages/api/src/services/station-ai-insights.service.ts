// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-station AI insight suppression. The only writer of the
 * `charging_stations.ai_insights_suppressed_*` columns (P3). While a station
 * is suppressed (until a date, or until resumed) the insight scan and the AI
 * workers create no insight or action for it (`stationInsightsSuppressedSql`);
 * the end date passing resumes them with no action. Suppressing closes the
 * station's open insights `dismissed` with the reason and expires its waiting
 * actions, through the insight and action services. Audited in the station
 * history.
 */

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, chargingStations, stationAuditLog, users, writeAudit } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { dismissStationInsights } from '@evtivity/services/ai-insight.service';
import { expireStationAiProposals } from '@evtivity/services/ai-proposal.service';
import type { AuditActorInfo } from '../lib/audit-actor.js';

export interface StationAiSuppression {
  suppressedAt: Date | null;
  suppressedUntil: Date | null;
  suppressedBy: string | null;
  suppressedByName: string | null;
  reason: string | null;
}

export interface SuppressResult extends StationAiSuppression {
  insightsDismissed: number;
  actionsExpired: number;
}

async function current(stationId: string): Promise<StationAiSuppression | null> {
  const [row] = await db
    .select({
      suppressedAt: chargingStations.aiInsightsSuppressedAt,
      suppressedUntil: chargingStations.aiInsightsSuppressedUntil,
      suppressedBy: chargingStations.aiInsightsSuppressedBy,
      reason: chargingStations.aiInsightsSuppressedReason,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
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
  stationId: string,
  actor: AuditActorInfo,
  before: StationAiSuppression,
  after: Record<string, unknown>,
  notes: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
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
 * Suppresses the station's AI insights from now until `until` (null: until
 * resumed). Null when the station is unknown.
 */
export async function suppressStationAiInsights(
  stationId: string,
  input: { reason: string; until: Date | null },
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<SuppressResult | null> {
  const before = await current(stationId);
  if (before == null) return null;
  await db
    .update(chargingStations)
    .set({
      aiInsightsSuppressedAt: new Date(),
      aiInsightsSuppressedUntil: input.until,
      aiInsightsSuppressedBy: actor.actorUserId,
      aiInsightsSuppressedReason: input.reason,
    })
    .where(eq(chargingStations.id, stationId));
  await auditChange(
    stationId,
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
  const actionsExpired = await expireStationAiProposals(
    stationId,
    input.reason,
    { actor: actor.actor, actorUserId: actor.actorUserId, actorLabel: actor.actorLabel },
    log,
  );
  const dismissed = await dismissStationInsights(
    stationId,
    input.reason,
    { actor: actor.actor, actorUserId: actor.actorUserId, actorApiKeyId: actor.actorApiKeyId },
    getPubSub(),
  );
  const after = await current(stationId);
  if (after == null) return null;
  return { ...after, insightsDismissed: dismissed.length, actionsExpired };
}

/** Resumes the station's AI insights. Null when the station is unknown. */
export async function resumeStationAiInsights(
  stationId: string,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<StationAiSuppression | null> {
  const before = await current(stationId);
  if (before == null) return null;
  if (before.suppressedAt == null) return before;
  await db
    .update(chargingStations)
    .set({
      aiInsightsSuppressedAt: null,
      aiInsightsSuppressedUntil: null,
      aiInsightsSuppressedBy: null,
      aiInsightsSuppressedReason: null,
    })
    .where(eq(chargingStations.id, stationId));
  await auditChange(
    stationId,
    actor,
    before,
    { aiInsightsSuppressedAt: null, aiInsightsSuppressedUntil: null },
    'AI insights resumed',
    log,
  );
  return current(stationId);
}
