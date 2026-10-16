// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI provider quota alerts (`ai_provider_alerts`, migration 0475). The only
 * writer of the table. A call with the company key that fails because the
 * provider account is out of credit or over its quota sets the alert; the
 * next successful call to that provider clears it. Background features skip
 * a provider with an active alert except for one probe call per
 * `AI_PROVIDER_PROBE_INTERVAL_MS`, so the alert clears without an operator.
 * The orchestration (notification, SSE) lives in `@evtivity/services/ai-alerts`.
 */

import { client } from '../config.js';

/** Background features let one call per provider through this often while it has an alert. */
export const AI_PROVIDER_PROBE_INTERVAL_MS = 15 * 60_000;

const TTL_MS = 60_000;

export interface AiProviderAlert {
  provider: string;
  /** When the alert started. */
  since: Date;
  /** The latest quota failure. */
  lastSeenAt: Date;
}

interface AlertRow {
  provider: string;
  since_at: Date;
  last_seen_at: Date;
}

let cached: AiProviderAlert[] | undefined;
let cachedAt = 0;

export function clearAiProviderAlertsCache(): void {
  cached = undefined;
  cachedAt = 0;
}

/**
 * The active provider alerts, oldest first, cached for 60 seconds. On a read
 * failure the last cached value is served; with none the error is thrown
 * (callers decide, P9).
 */
export async function getActiveAiProviderAlerts(): Promise<AiProviderAlert[]> {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < TTL_MS) return cached;
  try {
    const rows = await client<AlertRow[]>`
      SELECT provider, since_at, last_seen_at
      FROM ai_provider_alerts
      WHERE cleared_at IS NULL
      ORDER BY since_at, provider
    `;
    cached = rows.map((r) => ({
      provider: r.provider,
      since: new Date(r.since_at),
      lastSeenAt: new Date(r.last_seen_at),
    }));
    cachedAt = now;
    return cached;
  } catch (err) {
    if (cached === undefined) throw err;
    return cached;
  }
}

/**
 * Records a quota failure of `provider`. Returns `started: true` when this
 * failure started a new alert (none was active). The failure also counts as
 * the latest probe, so background features wait a full interval before the
 * next try.
 */
export async function recordAiProviderQuotaFailure(
  provider: string,
  now: Date = new Date(),
): Promise<{ started: boolean; since: Date }> {
  const rows = await client<{ since_at: Date; started: boolean }[]>`
    INSERT INTO ai_provider_alerts AS a
      (provider, since_at, last_seen_at, cleared_at, last_probe_at, updated_at)
    VALUES (${provider}, ${now}, ${now}, NULL, ${now}, ${now})
    ON CONFLICT (provider) DO UPDATE SET
      since_at = CASE WHEN a.cleared_at IS NULL THEN a.since_at ELSE EXCLUDED.since_at END,
      last_seen_at = EXCLUDED.last_seen_at,
      cleared_at = NULL,
      last_probe_at = EXCLUDED.last_probe_at,
      updated_at = EXCLUDED.updated_at
    RETURNING since_at, (since_at = last_seen_at) AS started
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('ai_provider_alerts upsert returned no row');
  clearAiProviderAlertsCache();
  return { started: row.started, since: new Date(row.since_at) };
}

/**
 * Clears the active alert of `provider`. Returns true when this call cleared
 * it (an alert was active), so only one process announces the change.
 */
export async function clearAiProviderAlert(
  provider: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await client`
    UPDATE ai_provider_alerts
    SET cleared_at = ${now}, updated_at = ${now}
    WHERE provider = ${provider} AND cleared_at IS NULL
    RETURNING provider
  `;
  clearAiProviderAlertsCache();
  return rows.length > 0;
}

/**
 * Claims the notification of the active alert of `provider` for `day`
 * (YYYY-MM-DD, system timezone): true for the one caller that may send it,
 * so each provider notifies at most once a day across processes (P7).
 */
export async function claimAiProviderAlertNotice(provider: string, day: string): Promise<boolean> {
  const rows = await client`
    UPDATE ai_provider_alerts
    SET notified_on = ${day}, updated_at = now()
    WHERE provider = ${provider} AND cleared_at IS NULL
      AND notified_on IS DISTINCT FROM ${day}
    RETURNING provider
  `;
  return rows.length > 0;
}

/**
 * Claims the background probe of `provider`: true for the one caller that may
 * make a model call although the alert is active, at most once per
 * `intervalMs` across processes. False while no alert is active (nothing to
 * probe) or another probe ran within the interval.
 */
export async function claimAiProviderProbe(
  provider: string,
  intervalMs: number = AI_PROVIDER_PROBE_INTERVAL_MS,
  now: Date = new Date(),
): Promise<boolean> {
  const before = new Date(now.getTime() - intervalMs);
  const rows = await client`
    UPDATE ai_provider_alerts
    SET last_probe_at = ${now}, updated_at = ${now}
    WHERE provider = ${provider} AND cleared_at IS NULL
      AND (last_probe_at IS NULL OR last_probe_at <= ${before})
    RETURNING provider
  `;
  return rows.length > 0;
}
