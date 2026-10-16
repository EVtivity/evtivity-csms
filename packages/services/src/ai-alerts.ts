// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI alerts shared by the API and the worker:
 * - Provider quota alerts. Every adapter built with the company key goes
 *   through `trackAiProviderCalls`: a `quota_exceeded` failure sets the alert
 *   (`ai_provider_alerts`), a completed call clears it. A new alert notifies
 *   the administrators (`ai.ProviderQuotaExceeded`, once per provider and
 *   day) and both changes publish `ai.alerts.changed` on `csms_events`.
 * - Background features (insights, workers, driver AI, support drafts) ask
 *   `aiProviderGate` before a call: `paused` while an alert is active, except
 *   one `probe` call per interval, so the alert clears without an operator.
 * - Budget notices: the threshold notices `recordAiUsage` claimed become
 *   `ai.BudgetWarning` and `ai.BudgetExhausted` notifications.
 * Recipients are the active users with `settings.ai:write` and access to every
 * site. Everything here is fail-open (P9): a failure is logged and never
 * reaches the model call or the ledger write.
 */

import { observeAdapter } from '@evtivity/ai/core';
import type { AiAdapter, AiProviderError } from '@evtivity/ai/core';
import {
  claimAiProviderAlertNotice,
  claimAiProviderProbe,
  clearAiProviderAlert,
  client,
  getActiveAiProviderAlerts,
  getSystemTimezone,
  recordAiProviderQuotaFailure,
} from '@evtivity/database';
import type { AiBudgetNotice } from '@evtivity/database';
import { createLogger, dispatchSystemNotification } from '@evtivity/lib';
import { AI_PROVIDER_LABELS, isAiProviderId } from '@evtivity/lib/ai-config';
import { AI_ALERTS_CHANGED_EVENT } from '@evtivity/lib/ai-usage';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

export const AI_PROVIDER_QUOTA_EXCEEDED_EVENT = 'ai.ProviderQuotaExceeded';
export const AI_BUDGET_WARNING_EVENT = 'ai.BudgetWarning';
export const AI_BUDGET_EXHAUSTED_EVENT = 'ai.BudgetExhausted';

/** Users with this permission (and access to every site) get the AI alerts. */
export const AI_ALERT_PERMISSION = 'settings.ai:write';

/** What a background feature may do with a provider: call it, call it once as a probe, or skip it. */
export type AiProviderGate = 'open' | 'probe' | 'paused';

const log = createLogger('ai-alerts');

function providerName(provider: string): string {
  return isAiProviderId(provider) ? AI_PROVIDER_LABELS[provider] : provider;
}

interface Recipient {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  timezone: string | null;
}

async function alertRecipients(): Promise<Recipient[]> {
  return client<Recipient[]>`
    SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
    FROM users u
    WHERE u.is_active AND u.has_all_site_access
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission = ${AI_ALERT_PERMISSION})
    ORDER BY u.id
  `;
}

/** Sends one system event to every recipient; one failure does not stop the others. */
async function notifyAll(eventType: string, variables: Record<string, unknown>): Promise<number> {
  const recipients = await alertRecipients();
  let sent = 0;
  for (const user of recipients) {
    try {
      const result = await dispatchSystemNotification(
        client,
        eventType,
        {
          email: user.email,
          phone: user.phone ?? undefined,
          firstName: user.first_name ?? undefined,
          lastName: user.last_name ?? undefined,
          language: user.language ?? undefined,
          timezone: user.timezone ?? undefined,
          userId: user.id,
        },
        { firstName: user.first_name ?? '', lastName: user.last_name ?? '', ...variables },
        ALL_TEMPLATES_DIRS,
      );
      if (result.delivered.length > 0) sent += 1;
    } catch (err) {
      // fail-open: one recipient's failure does not stop the others (P9).
      log.warn({ err, eventType, userId: user.id }, 'AI alert notification failed for a recipient');
    }
  }
  return sent;
}

async function publishAlertsChanged(): Promise<void> {
  try {
    await getPubSub().publish(
      'csms_events',
      JSON.stringify({ eventType: AI_ALERTS_CHANGED_EVENT }),
    );
  } catch (err) {
    // fail-open: the banner also refetches on its own (P9).
    log.warn({ err }, 'AI alerts change not published');
  }
}

async function today(now: Date): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: await getSystemTimezone() }).format(now);
}

/**
 * A call with the company key failed with `quota_exceeded`: records the
 * alert, announces a new one, and notifies the administrators at most once per
 * provider and day (`notified_on`, P7). Fail-open.
 */
export async function noteAiProviderQuotaExceeded(
  provider: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const { started, since } = await recordAiProviderQuotaFailure(provider, now);
    if (started) {
      log.warn({ provider }, 'AI provider account is out of credit or quota; AI features paused');
      await publishAlertsChanged();
    }
    if (!(await claimAiProviderAlertNotice(provider, await today(now)))) return;
    await notifyAll(AI_PROVIDER_QUOTA_EXCEEDED_EVENT, {
      provider,
      providerName: providerName(provider),
      since: since.toISOString(),
    });
  } catch (err) {
    // fail-open: the call already failed for its own reason (P9).
    log.warn({ err, provider }, 'AI provider quota alert not recorded');
  }
}

/**
 * A call with the company key completed: clears an active alert of the
 * provider. Reads the cached alerts first, so a call without an alert writes
 * nothing. Fail-open.
 */
export async function noteAiProviderSuccess(provider: string): Promise<void> {
  try {
    const active = await getActiveAiProviderAlerts();
    if (!active.some((a) => a.provider === provider)) return;
    if (await clearAiProviderAlert(provider)) {
      log.info({ provider }, 'AI provider answered again; quota alert cleared');
      await publishAlertsChanged();
    }
  } catch (err) {
    // fail-open: the next completed call clears it (P9).
    log.warn({ err, provider }, 'AI provider quota alert not cleared');
  }
}

/** Wraps an adapter that uses the company key so its calls keep the provider alert state. */
export function trackAiProviderCalls(adapter: AiAdapter): AiAdapter {
  const provider = adapter.provider;
  return observeAdapter(adapter, {
    onProviderError: (err: AiProviderError) =>
      err.code === 'quota_exceeded' ? noteAiProviderQuotaExceeded(provider) : undefined,
    onSuccess: () => noteAiProviderSuccess(provider),
  });
}

/**
 * Whether a background feature may call `provider` (company key): `open`
 * without an active alert, `probe` for the one caller per interval allowed to
 * try while it is active, else `paused`. A read failure answers `open`: the
 * call then fails or succeeds on its own (P9).
 */
export async function aiProviderGate(provider: string): Promise<AiProviderGate> {
  try {
    const active = await getActiveAiProviderAlerts();
    if (!active.some((a) => a.provider === provider)) return 'open';
    return (await claimAiProviderProbe(provider)) ? 'probe' : 'paused';
  } catch (err) {
    // fail-open: an unreadable alert state does not stop the feature (P9).
    log.warn({ err, provider }, 'AI provider alert state not read; calling the provider');
    return 'open';
  }
}

/**
 * Sends the operator notification of each budget threshold notice
 * `recordAiUsage` claimed (once per scope, month and level: the claim in
 * `ai_budget_notices`, P7). Fail-open.
 */
export async function dispatchAiBudgetNotices(notices: readonly AiBudgetNotice[]): Promise<void> {
  for (const notice of notices) {
    try {
      let siteName = '';
      if (notice.siteId !== null) {
        const [site] = await client<{ name: string }[]>`
          SELECT name FROM sites WHERE id = ${notice.siteId}
        `;
        siteName = site?.name ?? '';
      }
      await notifyAll(
        notice.level === 'exceeded' ? AI_BUDGET_EXHAUSTED_EVENT : AI_BUDGET_WARNING_EVENT,
        {
          scope: notice.scope,
          siteName,
          period: notice.period,
          percent: notice.percent,
          usedTokens: notice.usedTokens,
          limitTokens: notice.limitTokens,
        },
      );
    } catch (err) {
      // fail-open: the usage is recorded; only the email is lost (P9).
      log.warn({ err, scope: notice.scope, siteId: notice.siteId }, 'AI budget notice not sent');
    }
  }
}
