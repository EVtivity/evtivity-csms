// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Lightbulb, MapPin, ShieldAlert, Wrench } from 'lucide-react';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { IconBadge } from '@/components/ui/icon-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { ScrollSnapRow } from '@/components/ui/scroll-snap-row';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useHasPermission } from '@/lib/auth';
import { formatNumber } from '@/lib/formatting';
import { formatRelativeTime, useUserTimezone } from '@/lib/timezone';
import { useInsights } from './insight-api';
import type { InsightRow } from './insight-display';
import {
  INSIGHT_ICONS,
  insightHeadline,
  insightRows,
  insightSize,
  shownCategory,
} from './insight-display';

/** Insight cards the row holds: three in view on wide screens, the rest scroll. */
const WIDGET_ROWS = 12;
/** One card per view on phones, two from `sm`, three from `lg` (gap-4 between). */
const ITEM_WIDTH = 'w-full sm:w-[calc((100%-1rem)/2)] lg:w-[calc((100%-2rem)/3)]';
/** Active insights read to order and collapse the rows (the newest ones). */
const WIDGET_FETCH = 50;

function InsightTile({ row }: { row: InsightRow }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { insight, count } = row;
  const { icon, tone } = INSIGHT_ICONS[insight.kind];
  const size = insightSize(insight);
  const category = shownCategory(insight);
  const fix = insight.fixes[0];
  const actionPending = insight.action?.status === 'pending';
  return (
    <Link
      to={row.href}
      data-testid="ai-insight-row"
      className="block h-full rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card accent={tone} className="flex h-full gap-3 p-4 transition-colors hover:bg-accent">
        <IconBadge icon={icon} tone={tone} label={t(`aiInsights.kind.${insight.kind}`)} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium wrap-anywhere" data-testid="ai-insight-headline">
              {insightHeadline(t, insight)}
            </span>
            {category != null && (
              <Badge variant="outline" className="max-w-full whitespace-normal">
                {t(`aiInsights.category.${category}`)}
              </Badge>
            )}
            {size != null && (
              <Badge variant="secondary" className="max-w-full whitespace-normal">
                {t('aiInsights.widget.atDetection', {
                  value: t(`aiInsights.scope.${size.key}`, { count: size.count }),
                })}
              </Badge>
            )}
            {actionPending && (
              <Badge
                variant="warning"
                className="max-w-full whitespace-normal"
                data-testid="ai-insight-action-pending"
              >
                <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
                {t('aiInsights.action.pending')}
              </Badge>
            )}
            {count > 1 && (
              <Badge
                variant="info"
                className="max-w-full whitespace-normal"
                data-testid="ai-insight-similar"
              >
                {t('aiInsights.widget.similar', { count: count - 1 })}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {insight.siteName != null && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{insight.siteName}</span>
              </span>
            )}
            <span>{formatRelativeTime(insight.createdAt, timezone)}</span>
            {insight.confidence != null && category != null && (
              <Badge variant="outline" className="max-w-full whitespace-normal font-normal">
                {t(`aiInsights.confidenceBadge.${insight.confidence}`)}
              </Badge>
            )}
          </div>
          {fix != null && (
            <p className="flex items-start gap-1 text-xs" data-testid="ai-insight-fix">
              <Wrench
                className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>{t(`aiInsights.fix.${fix.code}`)}</span>
            </p>
          )}
        </div>
      </Card>
    </Link>
  );
}

/**
 * Dashboard "Active insights": the stat card layout with one card per open
 * insight in a row that scrolls sideways (three in view on wide screens, the
 * shared `ScrollSnapRow` with its dot indicator, like the Revenue cards).
 * Each card is built from structured fields (what, where, how big, the first
 * suggested fix, a pending action), never model text. Site incidents first,
 * then severity, then newest; the same kind and category at one site
 * collapses into one card. A card opens the
 * insight's page, "View all" the insights list. Shown with `aiInsights:read`
 * only while AI Insights are on (`aiInsightsEnabled`).
 */
export function ActiveInsightsWidget(): React.JSX.Element | null {
  const { t } = useTranslation();
  const canRead = useHasPermission('aiInsights:read');
  const { flags } = useFeatureFlags();
  const { insights, total, isLoading, isError, refetch } = useInsights(
    { status: 'active', limit: WIDGET_FETCH },
    flags.aiInsightsEnabled,
  );
  // AI Insights off (or the flags still loading): no card and no insights,
  // even when some stayed active from before.
  if (!canRead || !flags.aiInsightsEnabled) return null;
  const rows = insightRows(insights, WIDGET_ROWS);

  return (
    <Card data-testid="ai-active-insights">
      <CardHeader variant="stat">
        <CardTitle variant="stat">
          {t('aiInsights.activeInsights')}
          <InfoTooltip content={<div className="max-w-56">{t('aiInsights.widget.info')}</div>} />
        </CardTitle>
        <div className="flex items-center gap-2">
          {total > 0 && (
            <Badge variant="info" data-testid="ai-insights-total">
              {formatNumber(total, 0)}
            </Badge>
          )}
          <Lightbulb className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </CardHeader>
      {isLoading ? (
        <CardContent>
          <LoadingLogo size="inline" />
        </CardContent>
      ) : isError ? (
        <CardContent className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">{t('common.loadError')}</p>
          <Button type="button" variant="outline" size="sm" onClick={refetch}>
            {t('common.retry')}
          </Button>
        </CardContent>
      ) : rows.length === 0 ? (
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            {t('aiInsights.widget.empty')}
          </p>
        </CardContent>
      ) : (
        <CardContent>
          <ScrollSnapRow
            items={rows.map((row) => ({
              id: row.insight.id,
              content: <InsightTile row={row} />,
            }))}
            itemClassName={ITEM_WIDTH}
            gap="gap-4"
            testId="ai-insight-cards"
          />
        </CardContent>
      )}
      <CardFooter variant="divided">
        <Link
          to="/ai/insights?status=active"
          className={buttonVariants({ variant: 'link', size: 'xs' })}
          data-testid="ai-insights-view-all"
        >
          {t('aiInsights.widget.viewAll')}
        </Link>
      </CardFooter>
    </Card>
  );
}
