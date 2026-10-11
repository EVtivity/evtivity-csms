// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deterministic scope counts of an insight, computed in SQL and never by the
 * model: the counts of the subject's site (`site`), from the one shared query
 * `computeInsightScopeCounts` in `@evtivity/database` (the demo seed uses it too). A subject without a site
 * has no counts. No count spans every site (v0.1.45, plan section 5: the
 * all-sites counts were removed).
 */

import { client, computeInsightScopeCounts } from '@evtivity/database';
import type { InsightScopeInput } from '@evtivity/database';
import { RESERVATION_INSIGHT_KINDS } from '@evtivity/lib/ai-insights';
import type { InsightScope } from '@evtivity/lib/ai-insights';

export type ScopeInput = InsightScopeInput;

/** The site counts of the subject; empty for a subject without a site. */
export async function computeInsightScope(input: ScopeInput): Promise<InsightScope> {
  return computeInsightScopeCounts(input);
}

/** The record an insight is about, for its live scope. */
export interface LiveScopeSubject {
  kind: string;
  siteId: string | null;
  stationId: string | null;
  sessionId: string | null;
}

const STATION_SCOPE_KINDS: ReadonlySet<string> = new Set([
  'station_offline',
  'station_faulted',
  'station_alert',
]);

/** Kinds whose scope the analysis computes (worker summaries and findings have none). */
const LIVE_SCOPE_KINDS: ReadonlySet<string> = new Set([
  ...STATION_SCOPE_KINDS,
  'session_failed',
  'authorization_refused',
  'site_incident',
  ...RESERVATION_INSIGHT_KINDS,
]);

/**
 * The same counts as the stored snapshot, computed now with the same SQL and
 * the same inputs the analysis used (the station's latest error code, the
 * session's stop reason). SQL only: no model call. Null for kinds without a
 * scope.
 */
export async function computeLiveInsightScope(
  subject: LiveScopeSubject,
): Promise<InsightScope | null> {
  if (!LIVE_SCOPE_KINDS.has(subject.kind)) return null;
  let errorCode: string | null = null;
  let stoppedReason: string | null = null;
  if (STATION_SCOPE_KINDS.has(subject.kind) && subject.stationId != null) {
    const [row] = await client<{ error_code: string | null }[]>`
      SELECT payload ->> 'errorCode' AS error_code FROM ocpp_message_logs
      WHERE station_id = ${subject.stationId} AND action = 'StatusNotification'
        AND direction = 'inbound' AND payload ->> 'errorCode' IS NOT NULL
        AND payload ->> 'errorCode' <> 'NoError' AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    errorCode = row?.error_code ?? null;
  }
  if (subject.kind === 'session_failed' && subject.sessionId != null) {
    const [row] = await client<{ stopped_reason: string | null }[]>`
      SELECT stopped_reason FROM charging_sessions WHERE id = ${subject.sessionId}
    `;
    stoppedReason = row?.stopped_reason ?? null;
  }
  return computeInsightScope({ siteId: subject.siteId, errorCode, stoppedReason });
}
