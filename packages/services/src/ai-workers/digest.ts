// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The opt-in daily digest of AI insight actions waiting for a decision
 * (system event `ai.ProposalDigest`, decision D12). Recipients: active
 * operators with `aiInsights:write` who turned on
 * `user_notification_preferences.ai_digest_email`. Each gets the counts of
 * pending actions at their own sites, per worker job, the site names and a
 * link to the insights with a pending action. Structured content only: no
 * model text is ever emailed.
 */

import { client, getSystemTimezone } from '@evtivity/database';
import { createLogger, dispatchSystemNotification } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { COMPANY_SCOPE, claimAiWorkerRun, finishAiWorkerRun } from './runs.js';

export const AI_PROPOSAL_DIGEST_EVENT = 'ai.ProposalDigest';

/** Site names listed in one digest; more are counted as `+N`. */
export const DIGEST_MAX_SITE_NAMES = 10;

const moduleLogger = createLogger('ai-proposal-digest');

interface RecipientRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  language: string;
  has_all_site_access: boolean;
}

interface PendingRow {
  job: string | null;
  site_id: string | null;
  site_name: string | null;
}

export interface DigestCounts {
  pendingCount: number;
  stuckSessionsCount: number;
  networkSummaryCount: number;
  siteCount: number;
  siteNames: string;
}

/**
 * Counts of the insights with status `pending` (their action waits for a
 * decision) a user may see (their sites, unsited for all-site users). The
 * insight's status decides, the same as the list the email links to.
 */
export async function pendingDigestCounts(
  userId: string,
  allSites: boolean,
): Promise<DigestCounts> {
  const rows = await client<PendingRow[]>`
    SELECT p.job, p.site_id, s.name AS site_name
    FROM ai_proposals p
    JOIN ai_insights i ON i.id = p.insight_id AND i.status = 'pending'
    LEFT JOIN sites s ON s.id = p.site_id
    WHERE p.status = 'pending' AND p.decided_at IS NULL
      AND p.expires_at > now()
      AND (${allSites} OR p.site_id IN (
        SELECT a.site_id FROM user_site_assignments a WHERE a.user_id = ${userId}
      ))
  `;
  const names = [
    ...new Set(rows.map((r) => r.site_name).filter((n): n is string => n != null)),
  ].sort();
  const shown = names.slice(0, DIGEST_MAX_SITE_NAMES).join(', ');
  const more = names.length - DIGEST_MAX_SITE_NAMES;
  return {
    pendingCount: rows.length,
    stuckSessionsCount: rows.filter((r) => r.job === 'stuck_sessions').length,
    networkSummaryCount: rows.filter((r) => r.job === 'network_summary').length,
    siteCount: new Set(rows.map((r) => r.site_id).filter((id) => id != null)).size,
    siteNames: more > 0 ? `${shown} +${String(more)}` : shown,
  };
}

/**
 * Sends the digest of `digestDate` (YYYY-MM-DD, system timezone) to every
 * opted-in operator with pending insight actions, once per day: the day is claimed
 * as an `ai_worker_runs` row first (P7), so a rerun of the cron sends nothing.
 * Fail-open per recipient (P9). Returns the recipients a delivery went to.
 */
export async function sendAiProposalDigests(input: {
  digestDate: string;
  /** The CSMS insights list filtered to pending actions. */
  insightsUrl: string;
  templatesDirs: string | string[];
  log?: ServiceLogger;
}): Promise<{ sent: number; skipped: number; alreadySent: boolean }> {
  const log = input.log ?? moduleLogger;
  const runId = await claimAiWorkerRun({
    job: 'proposal_digest',
    scope: COMPANY_SCOPE,
    siteId: null,
    period: input.digestDate,
  });
  if (runId === null) return { sent: 0, skipped: 0, alreadySent: true };
  const recipients = await client<RecipientRow[]>`
    SELECT u.id, u.email, u.first_name, u.last_name, u.language, u.has_all_site_access
    FROM users u
    JOIN user_notification_preferences pref ON pref.user_id = u.id AND pref.ai_digest_email
    WHERE u.is_active
      AND EXISTS (
        SELECT 1 FROM user_permissions up
        WHERE up.user_id = u.id AND up.permission = 'aiInsights:write'
      )
  `;
  const timezone = await getSystemTimezone();
  let sent = 0;
  let skipped = 0;
  for (const user of recipients) {
    try {
      const counts = await pendingDigestCounts(user.id, user.has_all_site_access);
      if (counts.pendingCount === 0) {
        skipped += 1;
        continue;
      }
      const result = await dispatchSystemNotification(
        client,
        AI_PROPOSAL_DIGEST_EVENT,
        {
          email: user.email,
          firstName: user.first_name ?? undefined,
          lastName: user.last_name ?? undefined,
          language: user.language,
          timezone,
          userId: user.id,
        },
        {
          firstName: user.first_name ?? '',
          lastName: user.last_name ?? '',
          digestDate: input.digestDate,
          insightsUrl: input.insightsUrl,
          ...counts,
        },
        input.templatesDirs,
      );
      if (result.delivered.length > 0) sent += 1;
    } catch (err) {
      // fail-open: one recipient's failure does not stop the others (P9).
      log.warn({ err, userId: user.id }, 'AI proposal digest failed for a recipient');
    }
  }
  await finishAiWorkerRun(runId, { status: 'completed', output: { sent, skipped } });
  return { sent, skipped, alreadySent: false };
}
