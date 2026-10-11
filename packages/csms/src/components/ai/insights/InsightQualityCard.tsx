// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { INSIGHT_FEEDBACK_SUMMARY_DAYS } from '@evtivity/lib/ai-insights';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useHasPermission } from '@/lib/auth';
import { formatNumber, formatPercent } from '@/lib/formatting';
import { useInsightFeedbackSummary } from './insight-api';

/**
 * Settings > AI > Automatic Insights: how often operators found insights
 * helpful, by insight type, from the votes of the last 30 days on insights in
 * the user's sites. Read only, shared components only; votes never feed any
 * prompt. Shown with `aiInsights:read`.
 */
export function InsightQualityCard(): React.JSX.Element | null {
  const { t } = useTranslation();
  const canRead = useHasPermission('aiInsights:read');
  const { days, rates, isLoading, isError, refetch } = useInsightFeedbackSummary();
  if (!canRead) return null;
  const windowDays = days ?? INSIGHT_FEEDBACK_SUMMARY_DAYS;
  const anyWrong = rates.some((r) => r.wrong > 0);
  return (
    <Card data-testid="ai-insight-quality">
      <CardHeader>
        <CardTitle>{t('settings.aiInsightsSettings.quality.title')}</CardTitle>
        <CardDescription>
          {t('settings.aiInsightsSettings.quality.description', { days: windowDays })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-destructive">{t('common.loadError')}</span>
            <Button type="button" size="sm" variant="outline" onClick={refetch}>
              {t('common.retry')}
            </Button>
          </div>
        ) : rates.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-insight-quality-empty">
            {t('settings.aiInsightsSettings.quality.empty', { days: windowDays })}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.aiInsightsSettings.quality.columns.kind')}</TableHead>
                  <TableHead className="text-right">
                    {t('settings.aiInsightsSettings.quality.columns.helpful')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('settings.aiInsightsSettings.quality.columns.wrong')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('settings.aiInsightsSettings.quality.columns.rate')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rates.map((r) => (
                  <TableRow key={r.kind} data-testid="ai-insight-quality-row">
                    <TableCell>{t(`aiInsights.kind.${r.kind}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.helpful, 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.wrong, 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(r.helpful / (r.helpful + r.wrong))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {anyWrong && (
          <Link to="/ai/insights?feedback=wrong" className="text-sm text-link hover:underline">
            {t('settings.aiInsightsSettings.quality.viewWrong')}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
