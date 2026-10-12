// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { notInArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { aiInsights, isReservationEnabled } from '@evtivity/database';
import { isReservationInsightKind, RESERVATION_INSIGHT_KINDS } from '@evtivity/lib/ai-insights';
import { siteInScope } from './site-scope.js';

/**
 * The visibility gate of one automatic insight, shared by every
 * `/ai/insights/:id` route (detail, writes, actions) and the insight
 * neighbors route, so a row one of them hides is hidden by all of them.
 * An insight is visible when it is in the caller's sites (unsited ones for
 * all-site users only) and, for a reservation insight, while the reservation
 * feature is on (owner rule v0.1.45; the row stays stored and shows again
 * once it is on).
 */
export async function insightRowVisible(
  row: { siteId: string | null; kind: string },
  siteIds: readonly string[] | null,
): Promise<boolean> {
  if (!siteInScope(siteIds, row.siteId)) return false;
  return !isReservationInsightKind(row.kind) || (await isReservationEnabled());
}

/**
 * The feature part of `insightRowVisible` as SQL on `ai_insights`, or
 * undefined when nothing is hidden. The site part is the caller's site scope.
 */
export async function insightFeatureGateSql(): Promise<SQL | undefined> {
  if (await isReservationEnabled()) return undefined;
  return notInArray(aiInsights.kind, [...RESERVATION_INSIGHT_KINDS]);
}
