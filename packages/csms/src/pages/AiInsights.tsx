// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  INSIGHT_FEEDBACK_FILTERS,
  INSIGHT_KINDS,
  INSIGHT_VISIBLE_STATUSES,
  ROOT_CAUSE_CATEGORIES,
  isReservationInsightKind,
  isVisibleInsightStatus,
} from '@evtivity/lib/ai-insights';
import type {
  InsightFeedbackFilter,
  InsightKind,
  InsightVisibleStatus,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
import type { InsightFilter } from '@/components/ai/insights/insight-api';
import { InsightRecordLink } from '@/components/ai/insights/InsightRecordLink';
import {
  INSIGHTS_PAGE_SIZE,
  isSummaryInsight,
  useInsightPage,
} from '@/components/ai/insights/insight-api';
import {
  INSIGHT_ICONS,
  insightHeadline,
  insightPath,
} from '@/components/ai/insights/insight-display';
import { insightStatusVariant } from '@/lib/status-variants';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { IconBadge } from '@/components/ui/icon-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface SiteOption {
  id: string;
  name: string;
}

const COLUMNS = 7;

function pick<T extends string>(values: readonly T[], raw: string | null): T | undefined {
  return raw != null && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/**
 * Insights list (`/ai/insights`, `aiInsights:read`): every insight in the
 * user's sites, newest first, with the standard filter bar and table. The
 * filters live in the URL so the dashboard card can open a filtered list
 * (`feedback=wrong`: insights someone marked wrong, linked from Settings;
 * `status=pending`: insights whose action waits for a decision, linked from
 * the digest email and the sidebar count). The status column shows the one
 * status of the insight and its action.
 * A row opens the insight's page.
 */
export function AiInsights(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const canReadSites = useHasPermission('sites:read');
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);

  const status = pick<InsightVisibleStatus>(INSIGHT_VISIBLE_STATUSES, params.get('status'));
  // Reservation kinds only while reservations are on: the same switch the
  // insight routes use to leave reservation insights out (`reservation.enabled`).
  const { flags } = useFeatureFlags();
  const kinds = flags.reservationEnabled
    ? INSIGHT_KINDS
    : INSIGHT_KINDS.filter((k) => !isReservationInsightKind(k));
  const kind = pick<InsightKind>(kinds, params.get('kind'));
  const category = pick<RootCauseCategory>(ROOT_CAUSE_CATEGORIES, params.get('category'));
  const siteId = params.get('siteId') ?? '';
  const feedback = pick<InsightFeedbackFilter>(INSIGHT_FEEDBACK_FILTERS, params.get('feedback'));

  const filter: Omit<InsightFilter, 'limit'> = {};
  if (status != null) filter.status = status;
  if (kind != null) filter.kind = kind;
  if (category != null) filter.category = category;
  if (siteId !== '') filter.siteId = siteId;
  if (feedback != null) filter.feedback = feedback;
  const { insights, total, isLoading, isError } = useInsightPage(filter, page);
  const totalPages = Math.max(1, Math.ceil(total / INSIGHTS_PAGE_SIZE));

  const { data: sites } = useQuery({
    queryKey: ['sites', 'options'],
    queryFn: () => api.get<{ data: SiteOption[] }>('/v1/sites?limit=100'),
    enabled: canReadSites,
    staleTime: 60_000,
  });

  function setFilter(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{t('aiInsights.list.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('aiInsights.list.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-2">
            <Label htmlFor="ai-insights-status" className="leading-6">
              {t('common.status')}
            </Label>
            <Select
              id="ai-insights-status"
              value={status ?? ''}
              onChange={(e) => {
                setFilter('status', e.target.value);
              }}
            >
              <option value="">{t('aiInsights.list.allStatuses')}</option>
              {INSIGHT_VISIBLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`aiInsights.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-insights-kind" className="leading-6">
              {t('aiInsights.list.kind')}
            </Label>
            <Select
              id="ai-insights-kind"
              value={kind ?? ''}
              onChange={(e) => {
                setFilter('kind', e.target.value);
              }}
            >
              <option value="">{t('aiInsights.list.allKinds')}</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(`aiInsights.kind.${k}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-insights-category" className="leading-6">
              {t('aiInsights.categoryLabel')}
            </Label>
            <Select
              id="ai-insights-category"
              value={category ?? ''}
              onChange={(e) => {
                setFilter('category', e.target.value);
              }}
            >
              <option value="">{t('aiInsights.list.allCategories')}</option>
              {ROOT_CAUSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`aiInsights.category.${c}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-insights-feedback" className="leading-6">
              {t('aiInsights.list.feedback')}
            </Label>
            <Select
              id="ai-insights-feedback"
              value={feedback ?? ''}
              onChange={(e) => {
                setFilter('feedback', e.target.value);
              }}
            >
              <option value="">{t('aiInsights.list.allFeedback')}</option>
              <option value="wrong">{t('aiInsights.list.feedbackWrong')}</option>
              <option value="helpful">{t('aiInsights.list.feedbackHelpful')}</option>
            </Select>
          </div>
          {canReadSites && (
            <div className="space-y-2">
              <Label htmlFor="ai-insights-site" className="leading-6">
                {t('aiInsights.list.site')}
              </Label>
              <Select
                id="ai-insights-site"
                value={siteId}
                onChange={(e) => {
                  setFilter('siteId', e.target.value);
                }}
              >
                <option value="">{t('aiInsights.list.allSites')}</option>
                {(sites?.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table data-testid="ai-insights-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t('aiInsights.list.insight')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('aiInsights.categoryLabel')}</TableHead>
                <TableHead>{t('aiInsights.confidenceLabel')}</TableHead>
                <TableHead>{t('aiInsights.list.station')}</TableHead>
                <TableHead>{t('aiInsights.list.site')}</TableHead>
                <TableHead>{t('common.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={COLUMNS}>
                    <LoadingLogo size="inline" />
                  </TableCell>
                </TableRow>
              )}
              {isError && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-center text-sm text-destructive">
                    {t('common.loadError')}
                  </TableCell>
                </TableRow>
              )}
              {insights.map((insight) => {
                const { icon, tone } = INSIGHT_ICONS[insight.kind];
                return (
                  <TableRow
                    key={insight.id}
                    className="cursor-pointer"
                    data-testid="ai-insight-list-row"
                    onClick={() => {
                      void navigate(insightPath(insight));
                    }}
                  >
                    <TableCell className="min-w-64">
                      <div className="flex items-start gap-2">
                        <IconBadge icon={icon} tone={tone} size="sm" />
                        <div className="min-w-0">
                          <p className="font-medium text-link wrap-anywhere">
                            {insightHeadline(t, insight)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t(`aiInsights.kind.${insight.kind}`)}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {isVisibleInsightStatus(insight.status) && (
                        <Badge
                          variant={insightStatusVariant(insight.status)}
                          className="whitespace-nowrap"
                          data-testid="ai-insight-list-status"
                        >
                          {t(`aiInsights.status.${insight.status}`)}
                        </Badge>
                      )}
                    </TableCell>
                    {/* A summary has no root cause, and an insight not analyzed has none yet:
                        one note across both columns instead of two empty cells. */}
                    {isSummaryInsight(insight) || insight.category == null ? (
                      <TableCell colSpan={2} className="text-sm text-muted-foreground">
                        {isSummaryInsight(insight)
                          ? t('aiInsights.list.rootCauseNotApplicable')
                          : t('aiInsights.list.rootCauseNotAnalyzed')}
                      </TableCell>
                    ) : (
                      <>
                        <TableCell>
                          <Badge variant="outline">
                            {t(`aiInsights.category.${insight.category}`)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {insight.confidence != null ? (
                            t(`aiInsights.confidence.${insight.confidence}`)
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="whitespace-nowrap">
                      {insight.stationId != null ? (
                        <InsightRecordLink
                          kind="station"
                          id={insight.stationId}
                          label={insight.stationName}
                        />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {insight.siteId != null ? (
                        <InsightRecordLink
                          kind="site"
                          id={insight.siteId}
                          label={insight.siteName}
                        />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(insight.createdAt, timezone)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && !isError && insights.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-center text-muted-foreground">
                    {t('aiInsights.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
