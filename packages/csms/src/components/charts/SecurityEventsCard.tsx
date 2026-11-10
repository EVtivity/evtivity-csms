// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Security Events card of the Live dashboard: OCPP station security events
// of the user's stations by severity (donut) and by station (worst severity
// first, critical rows red), each row linking to the station's Security tab.
// GET /v1/dashboard/security-events (securityEvents:read); the severity
// filter narrows only the station list, the donut always shows every severity.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { useTranslation } from 'react-i18next';
import { SECURITY_SEVERITIES, type SecuritySeverity } from '@evtivity/lib/security-severity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
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
import { useAuth, useHasPermission } from '@/lib/auth';
import { escapeChartText, securitySeverityColors } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';
import { SEVERITY_VARIANT } from '@/lib/severity';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { ChartBody, queryState } from './ChartBody';

export const SECURITY_EVENT_RANGES = ['24h', '7d', '30d'] as const;
export type SecurityEventRange = (typeof SECURITY_EVENT_RANGES)[number];

/** The most station rows the API returns (SECURITY_EVENTS_STATION_LIMIT). */
export const SECURITY_EVENTS_STATION_LIMIT = 50;

export interface SecurityEventsReply {
  range: SecurityEventRange;
  since: string;
  counts: Record<SecuritySeverity, number>;
  total: number;
  stations: Array<{
    id: string;
    stationId: string;
    siteId: string | null;
    siteName: string | null;
    worstSeverity: SecuritySeverity;
    counts: Record<SecuritySeverity, number>;
    total: number;
    lastEventAt: string;
  }>;
  stationTotal: number;
}

interface SiteOption {
  id: string;
  name: string;
}

/** The request path of the card for its filters. */
export function securityEventsPath(
  range: SecurityEventRange,
  siteId: string,
  severity: SecuritySeverity | '',
): string {
  const params = new URLSearchParams({ range });
  if (siteId !== '') params.set('siteId', siteId);
  if (severity !== '') params.set('severity', severity);
  return `/v1/dashboard/security-events?${params.toString()}`;
}

export function SecurityEventsCard(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const isDark = useAuth((s) => s.theme) === 'dark';
  const timezone = useUserTimezone();
  const canReadSites = useHasPermission('sites:read');
  const [range, setRange] = useState<SecurityEventRange>('7d');
  const [siteId, setSiteId] = useState('');
  const [severity, setSeverity] = useState<SecuritySeverity | ''>('');

  const events = useQuery({
    queryKey: ['dashboard', 'security-events', range, siteId, severity],
    queryFn: () => api.get<SecurityEventsReply>(securityEventsPath(range, siteId, severity)),
    staleTime: 30_000,
  });
  // The API scopes the list: a site-restricted user gets only their sites.
  const sites = useQuery({
    queryKey: ['sites', 'dashboard-security-events-options'],
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
    staleTime: 60_000,
    enabled: canReadSites,
  });
  const siteOptions = sites.data?.data ?? [];

  const counts = events.data?.counts;
  const series = useMemo(() => SECURITY_SEVERITIES.map((s) => counts?.[s] ?? 0), [counts]);
  const options = useMemo<ApexOptions>(() => {
    const colors = securitySeverityColors(isDark);
    return {
      chart: { type: 'donut', fontFamily: 'inherit', background: 'transparent' },
      theme: { mode: isDark ? 'dark' : 'light' },
      labels: SECURITY_SEVERITIES.map((s) => escapeChartText(t(`severity.${s}`))),
      colors: SECURITY_SEVERITIES.map((s) => colors[s]),
      legend: { position: 'bottom' },
      dataLabels: { formatter: (val: number) => `${formatNumber(val, 0)}%` },
    };
  }, [isDark, t, i18n.language]);

  const stations = events.data?.stations ?? [];
  const stationTotal = events.data?.stationTotal ?? 0;
  const total = events.data?.total ?? 0;

  return (
    <Card data-testid="security-events-card">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.securityEvents.title')}
          <InfoTooltip
            content={<div className="max-w-56">{t('dashboard.securityEvents.info')}</div>}
          />
        </CardTitle>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="security-events-range" className="text-xs">
              {t('dashboard.securityEvents.range')}
            </Label>
            <Select
              id="security-events-range"
              className="w-auto"
              value={range}
              onChange={(e) => {
                const next = SECURITY_EVENT_RANGES.find((r) => r === e.target.value);
                if (next != null) setRange(next);
              }}
            >
              <option value="24h">{t('dashboard.securityEvents.range24h')}</option>
              <option value="7d">{t('dashboard.securityEvents.range7d')}</option>
              <option value="30d">{t('dashboard.securityEvents.range30d')}</option>
            </Select>
          </div>
          {canReadSites && siteOptions.length > 1 && (
            <div className="grid gap-1">
              <Label htmlFor="security-events-site" className="text-xs">
                {t('dashboard.securityEvents.site')}
              </Label>
              <Select
                id="security-events-site"
                className="w-auto max-w-48"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                }}
              >
                <option value="">{t('dashboard.securityEvents.allSites')}</option>
                {siteOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="grid gap-1">
            <Label htmlFor="security-events-severity" className="text-xs">
              {t('dashboard.securityEvents.severity')}
            </Label>
            <Select
              id="security-events-severity"
              className="w-auto"
              value={severity}
              onChange={(e) => {
                const next = SECURITY_SEVERITIES.find((s) => s === e.target.value);
                setSeverity(next ?? '');
              }}
            >
              <option value="">{t('dashboard.securityEvents.allSeverities')}</option>
              {SECURITY_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`severity.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ChartBody
          state={queryState(events)}
          isEmpty={total === 0}
          emptyText={t('dashboard.securityEvents.empty')}
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div data-testid="security-events-donut">
              <ReactApexChart options={options} series={series} type="donut" height={280} />
            </div>
            <div className="min-w-0 space-y-2">
              {stations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('dashboard.securityEvents.noStations')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('dashboard.securityEvents.station')}</TableHead>
                        <TableHead>{t('dashboard.securityEvents.site')}</TableHead>
                        <TableHead>{t('dashboard.securityEvents.worstSeverity')}</TableHead>
                        <TableHead className="text-right">
                          {t('dashboard.securityEvents.events')}
                        </TableHead>
                        <TableHead>{t('dashboard.securityEvents.lastEvent')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stations.map((row) => {
                        const critical = row.worstSeverity === 'critical';
                        return (
                          <TableRow
                            key={row.id}
                            data-testid="security-events-row"
                            data-severity={row.worstSeverity}
                            className={cn(
                              critical && 'border-l-4 border-l-destructive bg-destructive/10',
                            )}
                          >
                            <TableCell className="font-medium">
                              <Link
                                to={`/stations/${encodeURIComponent(row.id)}?tab=security`}
                                className="text-link hover:underline"
                              >
                                {row.stationId}
                              </Link>
                              {critical && (
                                <span className="sr-only">
                                  {`, ${t('dashboard.securityEvents.criticalRow')}`}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>{row.siteName ?? '-'}</TableCell>
                            <TableCell>
                              <Badge
                                variant={SEVERITY_VARIANT[row.worstSeverity] ?? 'outline'}
                                className={cn(critical && 'text-destructive-foreground')}
                              >
                                {t(`severity.${row.worstSeverity}`)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                            <TableCell className="whitespace-nowrap text-xs">
                              {formatDateTime(row.lastEventAt, timezone)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {stationTotal > stations.length && (
                <p className="text-xs text-muted-foreground">
                  {t('dashboard.securityEvents.truncated', {
                    shown: stations.length,
                    total: stationTotal,
                  })}
                </p>
              )}
            </div>
          </div>
        </ChartBody>
      </CardContent>
    </Card>
  );
}
