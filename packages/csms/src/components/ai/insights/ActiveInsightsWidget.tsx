// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Lightbulb, MapPin, Wrench } from 'lucide-react';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { IconBadge } from '@/components/ui/icon-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardList,
  CardListLink,
  CardTitle,
} from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
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

/** Rows the card shows. */
const WIDGET_ROWS = 5;
/** Active insights read to order and collapse the rows (the newest ones). */
const WIDGET_FETCH = 50;

function InsightRowLink({ row }: { row: InsightRow }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { insight, count } = row;
  const { icon, tone } = INSIGHT_ICONS[insight.kind];
  const size = insightSize(insight);
  const category = shownCategory(insight);
  const fix = insight.fixes[0];
  return (
    <CardListLink to={row.href} data-testid="ai-insight-row">
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
            <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t(`aiInsights.fix.${fix.code}`)}</span>
          </p>
        )}
      </div>
    </CardListLink>
  );
}

/**
 * Dashboard "Active insights": the stat card layout with one row per open insight, each built
 * from structured fields (what, where, how big, the first suggested fix),
 * never model text. Site incidents first, then severity, then newest; the
 * same kind and category at one site collapses into one row. A row opens the
 * insight's page, "View all" the insights list. Shown with `aiInsights:read`
 * while insights are generated or some are still open.
 */
export function ActiveInsightsWidget(): React.JSX.Element | null {
  const { t } = useTranslation();
  const canRead = useHasPermission('aiInsights:read');
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { insights, total, isLoading, isError, refetch } = useInsights({
    status: 'active',
    limit: WIDGET_FETCH,
  });
  if (!canRead) return null;
  if (!flags.aiInsightsEnabled && !flagsLoading && !isLoading && !isError && total === 0) {
    return null;
  }
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
        <CardContent variant="list">
          <CardList>
            {rows.map((row) => (
              <InsightRowLink key={row.insight.id} row={row} />
            ))}
          </CardList>
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
