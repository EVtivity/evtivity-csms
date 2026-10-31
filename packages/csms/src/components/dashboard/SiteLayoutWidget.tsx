// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The dashboard Site Layout widget: the 3D layout of one site, view only.
// The user picks the site (stored in the dashboard layout, `siteId` of the
// `chart.siteLayout3d` item); the layout is changed on the site's Layout tab.
// three.js loads with SiteLayout3D (React.lazy) only when the widget renders,
// and the scene renders only while the widget is on screen and the tab shows.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Map as MapIcon, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/content-state';
import { LoadingLogo } from '@/components/loading-logo';
import { LoadErrorRetry } from '@/components/charts/ChartBody';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { webglAvailable } from '@/lib/webgl';
import { useLayoutInsights, useSiteLayoutView } from '@/components/layout/site-layout-data';

// three.js loads only when the widget renders.
const SiteLayout3D = lazy(() => import('@/components/layout/SiteLayout3D'));

/** The stage: 360 px on phones, 460 px from sm. */
export const WIDGET_STAGE_CLASS = 'h-[360px] sm:h-[460px]';

export interface SiteOption {
  id: string;
  name: string;
  stationCount: number;
}

export const SITE_OPTIONS_QUERY_KEY = ['sites', 'dashboard-site-layout-options'] as const;

/** The default site: the first the user may access that has stations, else the first. */
export function defaultLayoutSite(sites: readonly SiteOption[]): SiteOption | undefined {
  return sites.find((s) => s.stationCount > 0) ?? sites[0];
}

/** True while the element is on screen and the browser tab shows. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [tabShown, setTabShown] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const el = ref.current;
    // Pausing an off-screen WebGL view (not list paging; see list-pagination-guard).
    if (el == null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry != null) setInView(entry.isIntersecting);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  useEffect(() => {
    const onChange = (): void => {
      setTabShown(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  return inView && tabShown;
}

function noop(): void {
  // View only: nothing moves.
}

export interface SiteLayoutWidgetProps {
  /** The site the user chose; null for the default site. */
  siteId: string | null;
  /** The chosen site was deleted or left the user's site scope (the API dropped it). */
  siteUnavailable: boolean;
  onSiteChange: (siteId: string) => void;
}

export function SiteLayoutWidget({
  siteId: chosenId,
  siteUnavailable,
  onSiteChange,
}: SiteLayoutWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(containerRef);
  const [webgl, setWebgl] = useState(webglAvailable);
  const [fitKey, setFitKey] = useState(0);

  // Site scoped by the API: a site-restricted user gets only their sites.
  const sites = useQuery({
    queryKey: SITE_OPTIONS_QUERY_KEY,
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
    staleTime: 60_000,
  });
  const options = sites.data?.data ?? [];
  const fallback = defaultLayoutSite(options);
  const siteId = chosenId ?? fallback?.id ?? '';
  const view = useSiteLayoutView(siteId, onScreen);
  const insights = useLayoutInsights(siteId, onScreen);
  const siteName = options.find((s) => s.id === siteId)?.name ?? view.siteName ?? siteId;
  // A chosen site past the first 100 is still listed, under its own name.
  const listed =
    siteId !== '' && !options.some((s) => s.id === siteId)
      ? [...options, { id: siteId, name: siteName, stationCount: 0 }]
      : options;

  const header = (
    <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <CardTitle className="text-base flex items-center gap-1.5">
        {t('dashboard.siteLayout.title')}
        <InfoTooltip content={<div className="max-w-56">{t('dashboard.siteLayout.info')}</div>} />
      </CardTitle>
      {listed.length > 0 && (
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <Select
            aria-label={t('dashboard.siteLayout.siteLabel')}
            className="col-span-2 sm:w-64"
            value={siteId}
            onChange={(e) => {
              onSiteChange(e.target.value);
            }}
          >
            {listed.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {webgl && view.stations.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setFitKey((k) => k + 1);
              }}
            >
              <RotateCcw className="h-4 w-4" />
              {t('dashboard.siteLayout.resetView')}
            </Button>
          )}
          <Link
            to={`/sites/${encodeURIComponent(siteId)}?tab=layout`}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'col-start-2')}
          >
            <MapIcon className="h-4 w-4" />
            {t('dashboard.siteLayout.openLayout')}
          </Link>
        </div>
      )}
    </CardHeader>
  );

  function body(): React.ReactNode {
    if (sites.isLoading || (siteId !== '' && view.isLoading)) {
      return (
        <div className={cn('flex items-center justify-center', WIDGET_STAGE_CLASS)}>
          <LoadingLogo size="inline" />
        </div>
      );
    }
    if (sites.isError || view.isError) {
      return (
        <LoadErrorRetry
          onRetry={() => {
            void sites.refetch();
            view.refetch();
          }}
        />
      );
    }
    if (siteId === '') return <EmptyState>{t('dashboard.siteLayout.noSites')}</EmptyState>;
    if (view.stations.length === 0) return <EmptyState>{t('sites.noStationsAtSite')}</EmptyState>;
    if (!webgl) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="site-layout-widget-webgl-note">
          {t('dashboard.siteLayout.webglUnavailable')}
        </p>
      );
    }
    return (
      <Suspense
        fallback={
          <div
            className={cn(
              'flex w-full items-center justify-center rounded-lg border-2 border-dashed text-sm text-muted-foreground',
              WIDGET_STAGE_CLASS,
            )}
          >
            {t('sites.layoutView.loading3d')}
          </div>
        }
      >
        <SiteLayout3D
          key={siteId}
          stations={view.stations}
          settings={view.settings}
          terminals={view.terminals}
          hierarchy={view.hierarchy}
          logoUrl={view.logoUrl}
          insights={insights}
          editing={false}
          viewOnly
          cameraView="front"
          stageClassName={WIDGET_STAGE_CLASS}
          active={onScreen}
          fitKey={fitKey}
          currentDrawKw={(id) => view.power.get(id)?.currentDrawKw}
          allocatedLimitKw={(id) => view.power.get(id)?.allocatedLimitKw}
          onMove={noop}
          onTransformerMove={noop}
          onUnavailable={() => {
            setWebgl(false);
          }}
        />
      </Suspense>
    );
  }

  return (
    <Card ref={containerRef} data-testid="site-layout-widget">
      {header}
      <CardContent className="space-y-3">
        {siteUnavailable && fallback != null && (
          <p className="text-xs text-muted-foreground" data-testid="site-layout-widget-fallback">
            {t('dashboard.siteLayout.siteUnavailable', { name: siteName })}
          </p>
        )}
        {body()}
      </CardContent>
    </Card>
  );
}
