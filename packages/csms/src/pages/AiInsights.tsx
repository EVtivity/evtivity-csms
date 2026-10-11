// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  INSIGHT_FEEDBACK_FILTERS,
  INSIGHT_KINDS,
  INSIGHT_STATUSES,
  ROOT_CAUSE_CATEGORIES,
  isReservationInsightKind,
} from '@evtivity/lib/ai-insights';
import type {
  InsightFeedbackFilter,
  InsightKind,
  InsightStatus,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
import type { InsightFilter } from '@/components/ai/insights/insight-api';
import { INSIGHTS_PAGE_SIZE, useInsightPage } from '@/components/ai/insights/insight-api';
import {
  INSIGHT_ICONS,
  insightHeadline,
  insightPath,
  shownCategory,
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
 * (`feedback=wrong`: insights someone marked wrong, linked from Settings).
 * A row opens the insight's page.
 */
export function AiInsights(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const canReadSites = useHasPermission('sites:read');
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);

  const status = pick<InsightStatus>(INSIGHT_STATUSES, params.get('status'));
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
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="ai-insights-status" className="leading-6">
              {t('common.status')}
            </Label>
            <Select
              id="ai-insights-status"
              className="h-9"
              value={status ?? ''}
              onChange={(e) => {
                setFilter('status', e.target.value);
              }}
            >
              <option value="">{t('aiInsights.list.allStatuses')}</option>
              {INSIGHT_STATUSES.map((s) => (
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
              className="h-9"
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
              className="h-9"
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
              className="h-9"
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
                className="h-9"
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
                const shown = shownCategory(insight);
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
                      <Badge variant={insightStatusVariant(insight.status)}>
                        {t(`aiInsights.status.${insight.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {shown != null ? (
                        <Badge variant="outline">{t(`aiInsights.category.${shown}`)}</Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {insight.confidence != null && shown != null ? (
                        t(`aiInsights.confidence.${insight.confidence}`)
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {insight.stationId != null ? (
                        <Link
                          to={`/stations/${insight.stationId}`}
                          className="hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          {insight.stationName ?? insight.stationId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {insight.siteId != null ? (
                        <Link
                          to={`/sites/${insight.siteId}`}
                          className="hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          {insight.siteName ?? insight.siteId}
                        </Link>
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
