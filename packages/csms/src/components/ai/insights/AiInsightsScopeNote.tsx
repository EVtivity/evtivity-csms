// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AiInsightScopeReason } from '@evtivity/lib/ai-insights';
import { useHasPermission } from '@/lib/auth';

/** `aiInsightsScope` of the station and site detail answers. */
export interface AiInsightsScopeStatus {
  enabled: boolean;
  reason: AiInsightScopeReason;
}

/** Insights do not run for the record now (AI Insights off, or outside the scope). */
export function aiInsightsScopeOff(scope: AiInsightsScopeStatus | undefined): boolean {
  return scope != null && !scope.enabled;
}

/** Settings > AI > Automatic Insights, where the scope and the AI switch live. */
export const AI_INSIGHTS_SETTINGS_PATH = '/settings?tab=ai&sub=insights';

/**
 * Why AI insights do not run for a station or site, with a link to the
 * setting that decides it for users who can read the settings.
 */
export function AiInsightsScopeNote({
  scope,
  'data-testid': testId,
}: {
  scope: AiInsightsScopeStatus;
  'data-testid'?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const canReadSettings = useHasPermission('settings.system:read');
  return (
    <p className="text-sm font-normal text-muted-foreground" data-testid={testId}>
      {t(`aiInsights.scopeStatus.reason.${scope.reason}`)}
      {canReadSettings && (
        <>
          {' · '}
          <Link to={AI_INSIGHTS_SETTINGS_PATH} className="text-link hover:underline">
            {t('aiInsights.scopeStatus.settingsLink')}
          </Link>
        </>
      )}
    </p>
  );
}
