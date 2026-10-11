// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { formatNumber } from '@/lib/formatting';
import { aiRequestErrorText } from '../ai-error-text';
import { UsageBar } from './UsageBar';
import { AI_USAGE_KEY, useAiCostFormatter, useSiteAiUsage } from './usage-api';

/** The site PATCH bound (`routes/sites.ts`). */
const MAX_SITE_BUDGET = 1_000_000_000_000;

export interface SiteAiFields {
  aiInsightsEnabled?: boolean;
  aiMonthlyTokenBudget?: number | null;
}

/** '' is "follow the setting" (null); else a whole number in range, or undefined when invalid. */
export function parseSiteBudget(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n <= MAX_SITE_BUDGET ? n : undefined;
}

/**
 * Site Detail AI card: this month's usage against
 * the site budget for users with `aiUsage:read`, and the budget override and
 * the automatic insights switch for users with access to every site and
 * `sites:write` (the API answers 404 to anyone else that sends them).
 */
export function SiteAiCard({
  siteId,
  site,
}: {
  siteId: string;
  site: SiteAiFields;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canReadUsage = useHasPermission('aiUsage:read');
  const allSites = useHasAllSiteAccess();
  const canWriteSites = useHasPermission('sites:write');
  const canEdit = allSites && canWriteSites;
  const { data: usage } = useSiteAiUsage(siteId, canReadUsage);
  const formatCost = useAiCostFormatter();

  const stored = site.aiMonthlyTokenBudget;
  const storedText = stored == null ? '' : String(stored);
  const [budget, setBudget] = useState(storedText);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  useEffect(() => {
    setBudget(storedText);
    setHasSubmitted(false);
  }, [storedText]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/v1/sites/${siteId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      void queryClient.invalidateQueries({ queryKey: AI_USAGE_KEY });
    },
  });

  if (!canReadUsage && !canEdit) return null;

  const parsed = parseSiteBudget(budget);
  const invalid = parsed === undefined;
  const dirty = budget !== storedText;
  const row = usage?.site;

  return (
    <Card data-testid="ai-site-card">
      <CardHeader>
        <CardTitle>{t('aiUsage.title')}</CardTitle>
        {!allSites && <CardDescription>{t('aiUsage.allSitesOnly')}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-6">
        {row != null && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                {t('aiUsage.used')}:{' '}
                <span className="font-medium">{formatNumber(row.budget.usedTokens, 0)}</span>
              </span>
              <span className="text-muted-foreground">
                {t('aiUsage.budget')}:{' '}
                {row.budget.limitTokens != null
                  ? formatNumber(row.budget.limitTokens, 0)
                  : t('aiUsage.noLimit')}
              </span>
            </div>
            <UsageBar percent={row.budget.percent} label={t('aiUsage.budget')} />
            {row.budget.percent != null && (
              <p className="text-xs text-muted-foreground">
                {t('aiUsage.percentUsed', { percent: formatNumber(row.budget.percent, 0) })}
              </p>
            )}
            {formatCost != null && (
              <p className="text-xs text-muted-foreground">
                {t('aiUsage.cost')}: {formatCost(row.totals.costMicros)}
              </p>
            )}
          </div>
        )}

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="site-ai-insights" className="leading-6">
              {t('aiUsage.siteInsights')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('aiUsage.siteInsightsHelp')}</p>
          </div>
          <Toggle
            id="site-ai-insights"
            checked={site.aiInsightsEnabled !== false}
            disabled={!canEdit || patch.isPending}
            onCheckedChange={(checked) => {
              patch.mutate({ aiInsightsEnabled: checked });
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="site-ai-budget" className="leading-6">
            {t('aiUsage.siteBudget')}
          </Label>
          <Input
            id="site-ai-budget"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            className={hasSubmitted && invalid ? 'max-w-sm border-destructive' : 'max-w-sm'}
            disabled={!canEdit}
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              patch.reset();
            }}
          />
          <p
            className={
              hasSubmitted && invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
            }
          >
            {t('aiUsage.siteBudgetHelp')}
          </p>
        </div>

        {patch.isError && (
          <p className="text-sm text-destructive">{aiRequestErrorText(patch.error, t)}</p>
        )}
        {canEdit && (
          <div className="flex items-center justify-end gap-4">
            {patch.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('settings.aiSaved')}</p>
            )}
            {dirty && (
              <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
            )}
            <SaveButton
              isPending={patch.isPending}
              disabled={!dirty}
              onClick={() => {
                setHasSubmitted(true);
                if (invalid) return;
                patch.mutate({ aiMonthlyTokenBudget: parsed });
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
