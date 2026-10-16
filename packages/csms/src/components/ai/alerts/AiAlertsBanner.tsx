// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import type { AiAlertsDto } from '@evtivity/lib/ai-usage';
import { AI_PROVIDER_LABELS, isAiProviderId } from '@evtivity/lib/ai-config';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';

/**
 * The AI alerts: providers whose account is out of credit or quota (AI
 * features are paused) and the company monthly budget at or past its warning
 * level. The SSE events `ai.alerts.changed` and `ai.usage.threshold`
 * invalidate the query; it also refetches every minute, so a budget that a
 * new month resets clears without an event.
 */
export const AI_ALERTS_KEY = ['ai', 'alerts'] as const;

const ALERTS_STALE_TIME_MS = 60_000;

export function useAiAlerts(enabled: boolean): AiAlertsDto | undefined {
  const { data } = useQuery({
    queryKey: AI_ALERTS_KEY,
    queryFn: () => api.get<AiAlertsDto>('/v1/ai/alerts'),
    enabled,
    staleTime: ALERTS_STALE_TIME_MS,
    refetchInterval: ALERTS_STALE_TIME_MS,
    retry: false,
  });
  return data;
}

function providerLabel(provider: string): string {
  return isAiProviderId(provider) ? AI_PROVIDER_LABELS[provider] : provider;
}

const PROVIDERS_LINK = '/settings?tab=ai&sub=providers';
const USAGE_LINK = '/settings?tab=ai&sub=usage';

/**
 * `layout`: the banner at the top of every page, for users with
 * `settings.ai:write` and access to every site, with links to Settings > AI.
 * `settings`: the same state at the top of Settings > AI, for anyone who can
 * read it, without the links.
 */
export function AiAlertsBanner({
  placement = 'layout',
  className,
}: {
  placement?: 'layout' | 'settings';
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canRead = useHasPermission('settings.ai:read');
  const canWrite = useHasPermission('settings.ai:write');
  const allSites = useHasAllSiteAccess();
  const enabled = allSites && (placement === 'settings' ? canRead : canWrite);
  const data = useAiAlerts(enabled);
  if (!enabled || data == null) return null;
  const budget = data.companyBudget;
  if (data.providers.length === 0 && budget == null) return null;
  const withLinks = placement === 'layout';

  return (
    <div className={cn('space-y-2', className)} data-testid="ai-alerts-banner">
      {data.providers.map((alert) => (
        <Alert key={alert.provider} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <div>
            <AlertTitle>
              {t('aiAlerts.providerTitle', { provider: providerLabel(alert.provider) })}
            </AlertTitle>
            <AlertDescription>
              {t('aiAlerts.providerBody', {
                provider: providerLabel(alert.provider),
                since: formatDateTime(alert.since, timezone),
              })}{' '}
              {withLinks && (
                <Link to={PROVIDERS_LINK} className="font-medium underline">
                  {t('aiAlerts.openSettings')}
                </Link>
              )}
            </AlertDescription>
          </div>
        </Alert>
      ))}
      {budget != null && (
        <Alert variant={budget.level === 'exceeded' ? 'destructive' : 'warning'}>
          <AlertTriangle className="h-4 w-4" />
          <div>
            <AlertTitle>
              {budget.level === 'exceeded'
                ? t('aiAlerts.budgetExhaustedTitle')
                : t('aiAlerts.budgetWarningTitle')}
            </AlertTitle>
            <AlertDescription>
              {budget.level === 'exceeded'
                ? t('aiUsage.thresholdExceededCompany')
                : t('aiUsage.thresholdWarningCompany', { percent: budget.percent })}{' '}
              {withLinks && (
                <Link to={USAGE_LINK} className="font-medium underline">
                  {t('aiAlerts.openUsage')}
                </Link>
              )}
            </AlertDescription>
          </div>
        </Alert>
      )}
    </div>
  );
}
