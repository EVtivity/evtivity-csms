// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useCallback, useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plug, Circle, Zap, Shield, Maximize2, Pencil, Check } from 'lucide-react';
import { LAYOUT_CARD_HEIGHT, LAYOUT_CARD_WIDTH, resolveCardDrop } from '@evtivity/lib/site-layout';
import { SaveButton } from '@/components/save-button';
import { ResetButton } from '@/components/reset-button';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { STATION_DISPLAY_STATES } from '@/lib/station-display-state';
import { webglAvailable } from '@/lib/webgl';
import { StationCard, type LayoutStation } from './StationCard';
import { CellularBadge, NewPlacementTag, StationStateIcon } from './StationStateIcon';
import { SCENE_COLORS } from './site-layout-colors';
import { STATUS_COLORS } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';

// three.js loads only when the 3D view shows.
const SiteLayout3D = lazy(() => import('./SiteLayout3D'));

type LayoutView = '3d' | '2d';
const VIEW_STORAGE_KEY = 'site-layout-view';

function readStoredView(): LayoutView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === '2d' ? '2d' : '3d';
  } catch {
    // fail-open: storage is unavailable in private mode, so the default 3D view shows
    return '3d';
  }
}

function storeView(view: LayoutView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // fail-open: storage is unavailable in private mode, so the choice lasts for this page only
  }
}

interface LoadManagementStation {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface LoadManagementResponse {
  config: {
    strategy: string;
    isEnabled: boolean;
  } | null;
  hierarchy: unknown[];
  stations: LoadManagementStation[];
}

interface SiteLayoutProps {
  siteId: string;
}

const COLUMN_COUNT = 5;
const SPACING_X = 200;
const SPACING_Y = 140;
const PADDING = 20;

function autoLayout(stations: LayoutStation[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  stations.forEach((station, i) => {
    const col = i % COLUMN_COUNT;
    const row = Math.floor(i / COLUMN_COUNT);
    positions.set(station.id, {
      x: PADDING + col * SPACING_X,
      y: PADDING + row * SPACING_Y,
    });
  });
  return positions;
}

export function SiteLayout({ siteId }: SiteLayoutProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const [collapseKey, setCollapseKey] = useState(0);
  const [view, setView] = useState<LayoutView>(readStoredView);
  const [webgl, setWebgl] = useState(webglAvailable);
  const [editing, setEditing] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const show3d = view === '3d' && webgl;

  const {
    data: stations,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['sites', siteId, 'layout'],
    queryFn: () => api.get<LayoutStation[]>(`/v1/sites/${siteId}/layout`),
  });

  const { data: loadManagement } = useQuery({
    queryKey: ['sites', siteId, 'load-management'],
    queryFn: () => api.get<LoadManagementResponse>(`/v1/sites/${siteId}/load-management`),
    refetchInterval: 5000,
  });

  const stationPowerMap = useMemo(() => {
    const map = new Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>();
    if (loadManagement?.stations != null) {
      for (const s of loadManagement.stations) {
        map.set(s.id, { currentDrawKw: s.currentDrawKw, allocatedLimitKw: s.allocatedLimitKw });
      }
    }
    return map;
  }, [loadManagement]);

  const saveMutation = useMutation({
    mutationFn: (positions: Array<{ stationId: string; positionX: number; positionY: number }>) =>
      api.put(`/v1/sites/${siteId}/layout`, { positions }),
    onSuccess: () => {
      setPendingPositions(new Map());
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'layout'] });
    },
  });

  const allZero = stations != null && stations.every((s) => s.positionX === 0 && s.positionY === 0);
  const autoPositions = useMemo(() => (allZero ? autoLayout(stations) : null), [allZero, stations]);

  const resolvedStations = useMemo(() => {
    if (stations == null) return [];
    return stations.map((station) => {
      const pending = pendingPositions.get(station.id);
      const auto = autoPositions?.get(station.id);
      return {
        ...station,
        positionX: pending?.x ?? auto?.x ?? station.positionX,
        positionY: pending?.y ?? auto?.y ?? station.positionY,
      };
    });
  }, [stations, pendingPositions, autoPositions]);

  // A 2D drop lands on the 20 px grid, inside the board and on no other card.
  const resolveDrop = useCallback(
    (stationId: string, x: number, y: number) => {
      const others = resolvedStations
        .filter((s) => s.id !== stationId)
        .map((s) => ({ x: s.positionX, y: s.positionY }));
      const own = resolvedStations.find((s) => s.id === stationId);
      const board = boardRef.current;
      const width = Math.max(
        board?.clientWidth ?? 0,
        ...resolvedStations.map((s) => s.positionX + LAYOUT_CARD_WIDTH),
      );
      const height = Math.max(
        board?.clientHeight ?? 0,
        ...resolvedStations.map((s) => s.positionY + LAYOUT_CARD_HEIGHT),
      );
      return resolveCardDrop(
        { x, y },
        others,
        { width, height },
        own != null ? { x: own.positionX, y: own.positionY } : { x: 0, y: 0 },
      );
    },
    [resolvedStations],
  );

  function chooseView(next: LayoutView): void {
    setView(next);
    storeView(next);
    if (next === '2d') setEditing(false);
  }

  function handleDragEnd(stationId: string, x: number, y: number): void {
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(stationId, { x, y });
      return next;
    });
  }

  function handleSave(): void {
    const positions = resolvedStations.map((s) => ({
      stationId: s.id,
      positionX: s.positionX,
      positionY: s.positionY,
    }));
    saveMutation.mutate(positions);
    setCollapseKey((k) => k + 1);
  }

  function handleReset(): void {
    setPendingPositions(new Map());
    setCollapseKey((k) => k + 1);
  }

  return (
    <TabPanel
      title={t('sites.layout')}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('sites.layoutView.viewLabel')} className="flex gap-2">
            <Button
              type="button"
              variant={view === '3d' ? 'default' : 'outline'}
              aria-pressed={view === '3d'}
              onClick={() => {
                chooseView('3d');
              }}
            >
              {t('sites.layoutView.view3d')}
            </Button>
            <Button
              type="button"
              variant={view === '2d' ? 'default' : 'outline'}
              aria-pressed={view === '2d'}
              onClick={() => {
                chooseView('2d');
              }}
            >
              {t('sites.layoutView.view2d')}
            </Button>
          </div>
          {show3d && resolvedStations.length > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setFitKey((k) => k + 1);
              }}
            >
              <Maximize2 className="h-4 w-4" />
              {t('sites.layoutView.fitToView')}
            </Button>
          )}
          {show3d && canWrite && resolvedStations.length > 0 && (
            <Button
              type="button"
              variant="outline"
              aria-pressed={editing}
              onClick={() => {
                setEditing((e) => !e);
              }}
            >
              {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
              {editing ? t('sites.layoutView.doneEditing') : t('sites.layoutView.editLayout')}
            </Button>
          )}
          {canWrite && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSave();
              }}
              noValidate
              className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex"
            >
              <ResetButton onClick={handleReset} disabled={pendingPositions.size === 0} />
              <SaveButton isPending={saveMutation.isPending} />
            </form>
          )}
        </div>
      }
    >
      {saveMutation.isError && (
        <p className="mb-3 text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
      )}
      {view === '3d' && !webgl && resolvedStations.length > 0 && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="site-layout-webgl-note">
          {t('sites.layoutView.webglUnavailable')}
        </p>
      )}
      {resolvedStations.length === 0 ? (
        <EmptyState>{t('sites.noStationsAtSite')}</EmptyState>
      ) : show3d ? (
        <Suspense
          fallback={
            <div className="flex h-[420px] w-full items-center justify-center rounded-lg border-2 border-dashed text-sm text-muted-foreground sm:h-[580px]">
              {t('sites.layoutView.loading3d')}
            </div>
          }
        >
          <SiteLayout3D
            stations={resolvedStations}
            editing={editing && canWrite}
            fitKey={fitKey}
            currentDrawKw={(id) => stationPowerMap.get(id)?.currentDrawKw}
            onMove={handleDragEnd}
            onUnavailable={() => {
              setWebgl(false);
              setEditing(false);
            }}
          />
        </Suspense>
      ) : (
        <div
          ref={boardRef}
          data-testid="site-layout-2d"
          className="relative w-full h-[700px] border-2 border-dashed rounded-lg overflow-auto"
        >
          {resolvedStations.map((station) => {
            const power = stationPowerMap.get(station.id);
            return (
              <StationCard
                key={station.id}
                station={station}
                onDragEnd={handleDragEnd}
                resolveDrop={resolveDrop}
                currentDrawKw={power?.currentDrawKw}
                allocatedLimitKw={power?.allocatedLimitKw}
                collapseKey={collapseKey}
              />
            );
          })}
          {loadManagement != null && loadManagement.stations.length > 0 && (
            <div className="absolute top-3 right-3 z-50 rounded-lg border bg-card/80 backdrop-blur-xs p-3 space-y-1.5 text-xs shadow-xs max-w-[180px]">
              <div className="flex items-center gap-1.5 font-semibold text-sm">
                <Zap className="h-3.5 w-3.5" />
                {t('sites.powerDraw')}
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('sites.layoutDraw')}</span>
                <span className="font-medium">
                  {formatNumber(
                    loadManagement.stations.reduce((sum, s) => sum + s.currentDrawKw, 0),
                    1,
                  )}{' '}
                  kW
                </span>
              </div>
              {loadManagement.config != null && loadManagement.config.isEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t('loadManagement.allocationStrategy')}
                  </span>
                  <span className="font-medium">
                    {loadManagement.config.strategy === 'priority_based'
                      ? t('loadManagement.priorityBased')
                      : t('loadManagement.equalShare')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        data-testid="site-layout-state-legend"
      >
        {show3d && (
          <>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: SCENE_COLORS.ac }}
              />
              {t('sites.layoutView.acPedestal')}
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: SCENE_COLORS.dc }}
              />
              {t('sites.layoutView.dcCharger')}
            </span>
          </>
        )}
        {STATION_DISPLAY_STATES.map((state) => (
          <span key={state} className="flex items-center gap-1">
            <StationStateIcon state={state} /> {t(`sites.layoutState.${state}`)}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <CellularBadge /> {t('sites.layoutView.cellularLegend')}
        </span>
        <span className="flex items-center gap-1">
          <NewPlacementTag /> {t('sites.layoutView.newLegend')}
        </span>
      </div>
      <div
        className={
          show3d
            ? 'hidden'
            : 'mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground'
        }
      >
        <span className="flex items-center gap-1">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />
            <span className="relative h-2 w-2 rounded-full bg-success" />
          </span>{' '}
          {t('status.online')}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-muted-foreground inline-block" />{' '}
          {t('status.offline')}
        </span>
        <span className="flex items-center gap-1">
          <Plug className="h-3.5 w-3.5 text-success" /> {t('status.available')}
        </span>
        <span className="flex items-center gap-1">
          <span className="relative inline-flex h-3 w-3">
            <span
              className="absolute inset-0 rounded-full animate-ping opacity-75"
              style={{ backgroundColor: STATUS_COLORS.occupied }}
            />
            <Circle
              className="relative h-3 w-3"
              style={{ color: STATUS_COLORS.occupied }}
              fill={STATUS_COLORS.occupied}
            />
          </span>{' '}
          {t('status.charging')}
        </span>
        <span className="flex items-center gap-1">
          <Circle
            className="h-3 w-3"
            style={{ color: STATUS_COLORS.reserved }}
            fill={STATUS_COLORS.reserved}
          />{' '}
          {t('status.reserved')}
        </span>
        <span className="flex items-center gap-1">
          <Circle className="h-3 w-3 text-destructive" fill={STATUS_COLORS.faulted} />{' '}
          {t('status.faulted')}
        </span>
        <span className="flex items-center gap-1">
          <Circle className="h-3 w-3 text-muted-foreground" fill={STATUS_COLORS.unavailable} />{' '}
          {t('status.unavailable')}
        </span>
        <span className="text-muted-foreground/40">|</span>
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <Shield className="h-3 w-3" />0 {t('stations.sp0')}
        </span>
        <span className="flex items-center gap-0.5 text-link">
          <Shield className="h-3 w-3" />1 {t('stations.sp1')}
        </span>
        <span className="flex items-center gap-0.5 text-success">
          <Shield className="h-3 w-3" />2 {t('stations.sp2')}
        </span>
        <span className="flex items-center gap-0.5 text-warning">
          <Shield className="h-3 w-3" />3 {t('stations.sp3')}
        </span>
      </div>
    </TabPanel>
  );
}
