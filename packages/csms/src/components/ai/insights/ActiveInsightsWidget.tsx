// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { isVisibleInsightStatus } from '@evtivity/lib/ai-insights';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { IconBadge } from '@/components/ui/icon-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { ScrollSnapRow } from '@/components/ui/scroll-snap-row';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useHasPermission } from '@/lib/auth';
import { formatNumber } from '@/lib/formatting';
import { insightStatusVariant } from '@/lib/status-variants';
import { formatRelativeTime, useUserTimezone } from '@/lib/timezone';
import { LIVE_INSIGHT_STATUS_FILTER, useInsights } from './insight-api';
import { actionLabel } from './insight-action';
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
  // Where and when only; what the insight says goes on the line above.
  const meta = [insight.siteName, formatRelativeTime(insight.createdAt, timezone)].filter(
    (v): v is string => v != null && v !== '',
  );
  const confidence =
    insight.confidence != null && category != null
      ? t(`aiInsights.confidenceBadge.${insight.confidence}`)
      : null;
  const sizeText =
    size != null
      ? t('aiInsights.widget.atDetection', {
          value: t(`aiInsights.scope.${size.key}`, { count: size.count }),
        })
      : null;
  // Root cause, confidence and size, dot separated like the meta line.
  const about = [
    category != null ? t(`aiInsights.category.${category}`) : null,
    confidence,
    sizeText,
  ].filter((v): v is string => v != null);
  // An insight with an action recommends that action; else its first fix step.
  const fixText =
    insight.action != null
      ? actionLabel(t, insight.action)
      : fix != null
        ? t(`aiInsights.fix.${fix.code}`)
        : null;
  // Every tile has the same rows: headline, status and root cause, meta line, first fix.
  return (
    <Link
      to={row.href}
      data-testid="ai-insight-row"
      className="block h-full rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card accent={tone} className="flex h-full gap-3 p-4 transition-colors hover:bg-accent">
        <IconBadge icon={icon} tone={tone} label={t(`aiInsights.kind.${insight.kind}`)} />
        <div className="min-w-0 flex-1 space-y-2">
          <p
            className="line-clamp-2 text-sm font-medium wrap-anywhere"
            data-testid="ai-insight-headline"
          >
            {insightHeadline(t, insight)}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {isVisibleInsightStatus(insight.status) && (
              <Badge
                variant={insightStatusVariant(insight.status)}
                data-testid={
                  insight.status === 'pending' ? 'ai-insight-action-pending' : 'ai-insight-status'
                }
              >
                {t(`aiInsights.status.${insight.status}`)}
              </Badge>
            )}
            {about.length > 0 && <span>{about.join(' · ')}</span>}
            {count > 1 && (
              <span className="text-link" data-testid="ai-insight-similar">
                {t('aiInsights.widget.similar', { count: count - 1 })}
              </span>
            )}
          </div>
          {meta.length > 0 && (
            <p className="truncate text-xs text-muted-foreground" title={meta.join(' · ')}>
              {meta.join(' · ')}
            </p>
          )}
          {fixText != null && (
            <p className="line-clamp-2 text-xs" data-testid="ai-insight-fix">
              {fixText}
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
    { status: LIVE_INSIGHT_STATUS_FILTER, limit: WIDGET_FETCH },
    flags.aiInsightsEnabled,
  );
  // AI Insights off (or the flags still loading): no card and no insights,
  // even when some stayed active from before.
  if (!canRead || !flags.aiInsightsEnabled) return null;
  const rows = insightRows(insights, WIDGET_ROWS);

  return (
    <Card tone="ai" data-testid="ai-active-insights">
      <CardHeader variant="stat">
        <CardTitle variant="stat">
          {t('aiInsights.activeInsights')}
          <InfoTooltip content={<div className="max-w-56">{t('aiInsights.widget.info')}</div>} />
        </CardTitle>
        <div className="flex items-center gap-3">
          {total > 0 && (
            <Badge variant="info" data-testid="ai-insights-total">
              {formatNumber(total, 0)}
            </Badge>
          )}
          <Link
            to="/ai/insights"
            className={buttonVariants({ variant: 'link', size: 'xs' })}
            data-testid="ai-insights-view-all"
          >
            {t('aiInsights.widget.viewAll')}
          </Link>
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
    </Card>
  );
}
