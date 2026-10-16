// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/timezone';
import { AiInsightsSuppressDialog } from './AiInsightsSuppressDialog';
import type { AiInsightsSuppressTarget } from './AiInsightsSuppressDialog';

interface StationSuppression {
  siteId: string | null;
  aiInsightsSuppressedSources?: string[];
  aiInsightsSuppressedUntil?: string | null;
}

interface SiteSuppression {
  aiInsightsSuppressedAt?: string | null;
  aiInsightsSuppressedUntil?: string | null;
}

/**
 * The suppression shortcuts of an insight detail: "Suppress for This
 * Station" (the insight has a station) and "Suppress for This Site" (the
 * insight has a site, directly or through its station), each opening the
 * shared suppress dialog. A button is hidden without the matching write
 * permission; a station or site already suppressed shows its state instead.
 * Renders nothing when there is nothing to show.
 */
export function InsightSuppressShortcuts({
  stationId,
  siteId,
  timezone,
}: {
  stationId: string | null;
  siteId: string | null;
  timezone: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const canReadStations = useHasPermission('stations:read');
  const canWriteStations = useHasPermission('stations:write');
  const canReadSites = useHasPermission('sites:read');
  const canWriteSites = useHasPermission('sites:write');
  const [dialog, setDialog] = useState<AiInsightsSuppressTarget | null>(null);

  // The same query keys as the station and site detail pages, so a
  // suppression made here or there refreshes both.
  const { data: station } = useQuery({
    queryKey: ['stations', stationId],
    queryFn: () =>
      api.get<StationSuppression>(`/v1/stations/${encodeURIComponent(stationId ?? '')}`),
    enabled: stationId != null && canReadStations,
  });
  const effectiveSiteId = siteId ?? station?.siteId ?? null;
  const { data: site } = useQuery({
    queryKey: ['sites', effectiveSiteId],
    queryFn: () =>
      api.get<SiteSuppression>(`/v1/sites/${encodeURIComponent(effectiveSiteId ?? '')}`),
    enabled: effectiveSiteId != null && canReadSites,
  });

  const items: React.ReactNode[] = [];
  if (stationId != null) {
    const sources = station?.aiInsightsSuppressedSources ?? [];
    if (sources.includes('station')) {
      items.push(
        <p key="station" data-testid="insight-station-suppressed">
          {station?.aiInsightsSuppressedUntil != null
            ? t('aiInsights.detail.stationSuppressedUntil', {
                date: formatDateTime(station.aiInsightsSuppressedUntil, timezone),
              })
            : t('aiInsights.detail.stationSuppressedUntilResumed')}
        </p>,
      );
    } else if (sources.includes('site')) {
      items.push(
        <p key="station" data-testid="insight-station-suppressed">
          {t('aiInsights.detail.stationSuppressedWithSite')}
        </p>,
      );
    } else if (canWriteStations) {
      items.push(
        <Button
          key="station"
          variant="outline"
          size="sm"
          onClick={() => {
            setDialog('station');
          }}
        >
          {t('aiInsights.detail.suppressStation')}
        </Button>,
      );
    }
  }
  if (effectiveSiteId != null) {
    if (site?.aiInsightsSuppressedAt != null) {
      items.push(
        <p key="site" data-testid="insight-site-suppressed">
          {site.aiInsightsSuppressedUntil != null
            ? t('aiInsights.detail.siteSuppressedUntil', {
                date: formatDateTime(site.aiInsightsSuppressedUntil, timezone),
              })
            : t('aiInsights.detail.siteSuppressedUntilResumed')}
        </p>,
      );
    } else if (canWriteSites) {
      items.push(
        <Button
          key="site"
          variant="outline"
          size="sm"
          onClick={() => {
            setDialog('site');
          }}
        >
          {t('aiInsights.detail.suppressSite')}
        </Button>,
      );
    }
  }
  if (items.length === 0) return null;

  return (
    <>
      <dt className="text-muted-foreground">{t('aiInsights.detail.suppressionLabel')}</dt>
      <dd className="min-w-0 space-y-2" data-testid="insight-suppress-shortcuts">
        <div className="flex flex-wrap items-center gap-2">{items}</div>
        {stationId != null && (
          <AiInsightsSuppressDialog
            target="station"
            id={stationId}
            open={dialog === 'station'}
            onOpenChange={(open) => {
              setDialog(open ? 'station' : null);
            }}
          />
        )}
        {effectiveSiteId != null && (
          <AiInsightsSuppressDialog
            target="site"
            id={effectiveSiteId}
            open={dialog === 'site'}
            onOpenChange={(open) => {
              setDialog(open ? 'site' : null);
            }}
          />
        )}
      </dd>
    </>
  );
}
