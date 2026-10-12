// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import type { AiUsageBudget, AiUsageDto, AiUsageTotals } from '@evtivity/lib/ai-usage';
import { LoadingLogo } from '@/components/loading-logo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { MonthPicker, monthOf } from '@/components/ui/month-picker';
import { Pagination } from '@/components/ui/pagination';
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
import { formatNumber } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { UsageBar } from './UsageBar';
import { useAiCostFormatter, useCompanyAiUsage } from './usage-api';

/** Sites per page of the Sites card (the unattributed row sits on the last page). */
const SITES_PAGE_SIZE = 10;

interface UserName {
  firstName: string | null;
  lastName: string | null;
  email: string;
}

/** Names of the top users: `topUsers` carries ids only, and names need `users:read`. */
function useUserNames(ids: readonly string[]): Map<string, string> {
  const canRead = useHasPermission('users:read');
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['users', id],
      queryFn: () => api.get<UserName>(`/v1/users/${encodeURIComponent(id)}`),
      enabled: canRead,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const names = new Map<string, string>();
  ids.forEach((id, i) => {
    const user = results[i]?.data;
    if (user == null) return;
    const full = [user.firstName, user.lastName].filter((p) => p != null && p !== '').join(' ');
    names.set(id, full !== '' ? full : user.email);
  });
  return names;
}

function BudgetCell({
  budget,
  warnPercent,
}: {
  budget: AiUsageBudget;
  warnPercent: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="min-w-32 space-y-1">
      <span className="text-xs text-muted-foreground">
        {budget.limitTokens != null
          ? t('aiUsage.percentUsed', { percent: formatNumber(budget.percent ?? 0, 0) })
          : t('aiUsage.noLimit')}
      </span>
      <UsageBar percent={budget.percent} warnPercent={warnPercent} label={t('aiUsage.budget')} />
    </div>
  );
}

/** Budget banners from the loaded usage: a scope at or past the warning level. */
function UsageWarnings({
  usage,
  warnPercent,
}: {
  usage: AiUsageDto;
  warnPercent: number;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const lines: { key: string; text: string; exceeded: boolean }[] = [];
  const company = usage.company?.budget.percent;
  if (company != null && company >= warnPercent) {
    lines.push({
      key: 'company',
      exceeded: company >= 100,
      text:
        company >= 100
          ? t('aiUsage.thresholdExceededCompany')
          : t('aiUsage.thresholdWarningCompany', { percent: warnPercent }),
    });
  }
  for (const site of usage.sites) {
    const p = site.budget.percent;
    if (p == null || p < warnPercent) continue;
    lines.push({
      key: site.siteId,
      exceeded: p >= 100,
      text:
        p >= 100
          ? t('aiUsage.thresholdExceededSite', { site: site.siteName })
          : t('aiUsage.thresholdWarningSite', { site: site.siteName, percent: warnPercent }),
    });
  }
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="ai-usage-warnings">
      {lines.map((l) => (
        <Alert key={l.key} variant={l.exceeded ? 'destructive' : 'warning'}>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{l.text}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

/** A per-surface share chart: one bar per surface, scaled to the largest. */
function SurfaceBars({
  rows,
  formatCost,
}: {
  rows: AiUsageDto['surfaces'];
  formatCost: ((micros: number) => string) | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.totals.totalTokens));
  if (rows.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">{t('common.noResults')}</p>;
  }
  return (
    <ul className="space-y-3" data-testid="ai-usage-surfaces">
      {rows.map((r) => (
        <li key={r.surface} className="space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>{t(`aiUsage.surface.${r.surface}`)}</span>
            <span className="text-muted-foreground">
              {formatNumber(r.totals.totalTokens, 0)}
              {formatCost != null && ` · ${formatCost(r.totals.costMicros)}`}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${String((r.totals.totalTokens / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TotalsCells({
  totals,
  formatCost,
}: {
  totals: AiUsageTotals;
  formatCost: ((micros: number) => string) | null;
}): React.JSX.Element {
  return (
    <>
      <TableCell className="whitespace-nowrap text-right">
        {formatNumber(totals.totalTokens, 0)}
      </TableCell>
      {formatCost != null && (
        <TableCell className="whitespace-nowrap text-right">
          {formatCost(totals.costMicros)}
        </TableCell>
      )}
    </>
  );
}

/**
 * Settings > AI > Usage: the company budget,
 * every site in scope, the usage per surface and the top users. Tokens
 * always; cost only when the company currency is USD.
 */
export function AiUsageTab({ warnPercent }: { warnPercent: number }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [month, setMonth] = useState('');
  const [sitePage, setSitePage] = useState(1);
  const { data, isLoading, isError } = useCompanyAiUsage(month !== '' ? month : null);
  const formatCost = useAiCostFormatter();
  const userIds = (data?.topUsers ?? []).map((u) => u.userId);
  const names = useUserNames(userIds);
  const sites = data?.sites ?? [];
  const sitePageCount = Math.max(1, Math.ceil(sites.length / SITES_PAGE_SIZE));
  const shownSitePage = Math.min(sitePage, sitePageCount);
  const sitesOnPage = sites.slice(
    (shownSitePage - 1) * SITES_PAGE_SIZE,
    shownSitePage * SITES_PAGE_SIZE,
  );

  return (
    <div className="space-y-6" data-testid="ai-usage-tab">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Label htmlFor="ai-usage-month" className="leading-6">
            {t('aiUsage.month')}
          </Label>
          <MonthPicker
            id="ai-usage-month"
            value={month !== '' ? month : (data?.month ?? monthOf(new Date()))}
            onChange={(value) => {
              setMonth(value);
              setSitePage(1);
            }}
          />
        </div>
        {data != null && (
          <p className="text-xs text-muted-foreground">
            {t('aiUsage.period')}: {formatDateTime(data.period.start, timezone)} -{' '}
            {formatDateTime(new Date(Date.parse(data.period.end) - 1).toISOString(), timezone)}
          </p>
        )}
      </div>

      {isLoading ? (
        <LoadingLogo size="inline" />
      ) : isError || data == null ? (
        <p className="text-sm text-destructive">{t('common.loadError')}</p>
      ) : (
        <>
          <UsageWarnings usage={data} warnPercent={warnPercent} />

          {data.company != null && (
            <Card>
              <CardHeader>
                <CardTitle>{t('aiUsage.company')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>
                    {t('aiUsage.used')}:{' '}
                    <span className="font-medium" data-testid="ai-usage-company-used">
                      {formatNumber(data.company.budget.usedTokens, 0)}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    {t('aiUsage.budget')}:{' '}
                    {data.company.budget.limitTokens != null
                      ? formatNumber(data.company.budget.limitTokens, 0)
                      : t('aiUsage.noLimit')}
                  </span>
                </div>
                <UsageBar
                  percent={data.company.budget.percent}
                  warnPercent={warnPercent}
                  label={t('aiUsage.company')}
                />
                {formatCost != null && (
                  <p className="text-xs text-muted-foreground" data-testid="ai-usage-cost">
                    {t('aiUsage.cost')}: {formatCost(data.company.totals.costMicros)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('aiUsage.sites')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('aiUsage.site')}</TableHead>
                      <TableHead className="text-right">{t('aiUsage.tokens.total')}</TableHead>
                      {formatCost != null && (
                        <TableHead className="text-right">{t('aiUsage.cost')}</TableHead>
                      )}
                      <TableHead>{t('aiUsage.budget')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sitesOnPage.map((site) => (
                      <TableRow key={site.siteId}>
                        <TableCell className="font-medium">
                          <Link
                            to={`/sites/${site.siteId}?tab=ai`}
                            className="text-link hover:underline"
                          >
                            {site.siteName}
                          </Link>
                        </TableCell>
                        <TotalsCells totals={site.totals} formatCost={formatCost} />
                        <TableCell>
                          <BudgetCell budget={site.budget} warnPercent={warnPercent} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {data.unattributed != null && shownSitePage === sitePageCount && (
                      <TableRow>
                        <TableCell className="text-muted-foreground">
                          {t('aiUsage.unattributed')}
                        </TableCell>
                        <TotalsCells totals={data.unattributed} formatCost={formatCost} />
                        <TableCell />
                      </TableRow>
                    )}
                    {data.sites.length === 0 && data.unattributed == null && (
                      <TableRow>
                        <TableCell
                          colSpan={formatCost != null ? 4 : 3}
                          className="text-center text-sm text-muted-foreground"
                        >
                          {t('common.noResults')}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4">
                <Pagination
                  page={shownSitePage}
                  totalPages={sitePageCount}
                  onPageChange={setSitePage}
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('aiUsage.bySurface')}</CardTitle>
              </CardHeader>
              <CardContent>
                <SurfaceBars rows={data.surfaces} formatCost={formatCost} />
              </CardContent>
            </Card>

            {data.topUsers != null && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('aiUsage.topUsers')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('aiUsage.user')}</TableHead>
                          <TableHead className="text-right">{t('aiUsage.tokens.total')}</TableHead>
                          {formatCost != null && (
                            <TableHead className="text-right">{t('aiUsage.cost')}</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.topUsers.map((u) => (
                          <TableRow key={u.userId}>
                            <TableCell className="break-all" data-testid="ai-usage-top-user">
                              {names.get(u.userId) ?? u.userId}
                            </TableCell>
                            <TotalsCells totals={u.totals} formatCost={formatCost} />
                          </TableRow>
                        ))}
                        {data.topUsers.length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={formatCost != null ? 3 : 2}
                              className="text-center text-sm text-muted-foreground"
                            >
                              {t('common.noResults')}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
