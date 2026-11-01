// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useCallback, useLayoutEffect, useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Zap, Maximize2, Pencil, Check, History } from 'lucide-react';
import {
  LAYOUT_CARD_HEIGHT,
  LAYOUT_CARD_WIDTH,
  LAYOUT_PADDING,
  LAYOUT_SPACING_X,
  LAYOUT_SPACING_Y,
  chargerMountingOf,
  effectiveLayoutSettings,
  energyAssetsOf,
  layoutCapacity,
  layoutRowLengths,
  siteTypeOf,
  fitPositionsToGrid,
  gridBoardExtent,
  positionToBay,
  resolveCardDrop,
  snapTransformerToGrass,
  usesFreePositions,
  type FreePlacement,
  type SiteLayoutSettings,
  accessibleChargingSpace,
  bayToPosition,
  heldSpots,
  sharesSpotPair,
  splitDispenserCount,
  spanSpots,
  spotPairPartner,
} from '@evtivity/lib/site-layout';
import { SaveButton } from '@/components/save-button';
import { ResetButton } from '@/components/reset-button';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { LoadingLogo } from '@/components/loading-logo';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { webglAvailable } from '@/lib/webgl';
import { StationCard, type LayoutStation } from './StationCard';
import { StationLayoutPopup } from './StationLayoutPopup';
import { placeLayoutPopup } from './layout-popup-position';
import { STAGE_HEIGHT_CLASS } from './site-layout-stage';
import { cn } from '@/lib/utils';
import { ConnectionLegend, StationStateLegend } from './StationStateIcon';
import { SCENE_COLORS } from './site-layout-colors';
import { LayoutSettingsPanel } from './LayoutSettingsPanel';
import { PowerEquipmentField } from './PowerEquipment';
import { useSiteTerminals } from './layout-terminals';
import {
  autoLayout,
  useBrandingLogo,
  useLayoutInsights,
  type LoadManagementResponse,
} from './site-layout-data';
import { LayoutReplayBar } from './LayoutReplayBar';
import {
  localDate,
  replayFrame,
  replayLastMinute,
  replayMoment,
  type ReplayDay,
  type ReplaySpeed,
} from './site-layout-replay';
import { formatNumber } from '@/lib/formatting';
import { CustomLayoutBoard, customBoardGeometry, customCardPositions } from './CustomLayoutBoard';
import { freeStationPlaces, layoutStationCountsOf, stationLayoutKindOf } from './site-layout-free';
import { isCaliforniaSite } from './site-layout-signs';
import { layoutLegend } from './site-layout-legend';
import { DepotLayoutBoard, depotStationBays } from './DepotLayoutBoard';

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

interface SiteLayoutProps {
  siteId: string;
}

export function SiteLayout({ siteId }: SiteLayoutProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  // Custom site: stations moved or turned in Edit Layout (or the 2D view), saved with Save.
  const [pendingFree, setPendingFree] = useState<Map<string, FreePlacement>>(new Map());
  // The station whose popup shows in the 2D view (the 3D view keeps its own).
  const [selected2d, setSelected2d] = useState<string | null>(null);
  const popup2dRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<LayoutView>(readStoredView);
  const [webgl, setWebgl] = useState(webglAvailable);
  const [editing, setEditing] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  // Lot and transformer edits of Edit Layout, saved with the layout Save.
  const [pendingSettings, setPendingSettings] = useState<SiteLayoutSettings | null>(null);
  const [settingsInvalid, setSettingsInvalid] = useState(false);
  const [settingsPanelKey, setSettingsPanelKey] = useState(0);
  const terminals = useSiteTerminals(siteId);
  const insights = useLayoutInsights(siteId, true);
  // Day replay (Layout tab only): the chosen day, the minute into it, play and speed.
  const [replayDate, setReplayDate] = useState<string | null>(null);
  // The 3D stage is full screen: the replay bar shows inside it.
  const [stageFullScreen, setStageFullScreen] = useState(false);
  const [replayMinute, setReplayMinute] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(15);
  const replaying = replayDate != null;
  const replay = useQuery({
    queryKey: ['sites', siteId, 'layout-replay', replayDate],
    queryFn: () =>
      api.get<ReplayDay>(
        `/v1/sites/${siteId}/layout/replay?date=${encodeURIComponent(replayDate ?? '')}`,
      ),
    enabled: replaying,
    // Today's replay grows while it is open; a past day does not change.
    staleTime: 60_000,
  });

  const { data: site } = useQuery({
    queryKey: ['sites', siteId],
    queryFn: () =>
      api.get<{
        state?: string | null;
        country?: string | null;
        reservationsEnabled?: boolean;
        layoutSettings: SiteLayoutSettings | null;
      }>(`/v1/sites/${siteId}`),
  });
  // Public branding: the company logo on the back of the 3D chargers.
  const logoUrl = useBrandingLogo();
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
    mutationFn: (body: {
      positions: Array<{
        stationId: string;
        positionX: number;
        positionY: number;
        freePosition?: FreePlacement;
      }>;
      settings?: SiteLayoutSettings;
    }) => api.put(`/v1/sites/${siteId}/layout`, body),
    // A saved layout leaves Edit Layout; a failed save keeps the mode and the
    // pending positions and settings, and shows the error.
    onSuccess: () => {
      setEditing(false);
      setPendingPositions(new Map());
      setPendingFree(new Map());
      setPendingSettings(null);
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
    },
  });

  const allZero = stations != null && stations.every((s) => s.positionX === 0 && s.positionY === 0);
  const autoPositions = useMemo(() => (allZero ? autoLayout(stations) : null), [allZero, stations]);

  const placedStations = useMemo(() => {
    if (stations == null) return [];
    return stations.map((station) => {
      const pending = pendingPositions.get(station.id);
      const auto = autoPositions?.get(station.id);
      const free = pendingFree.get(station.id);
      return {
        ...station,
        positionX: pending?.x ?? auto?.x ?? station.positionX,
        positionY: pending?.y ?? auto?.y ?? station.positionY,
        ...(free != null ? { freePosition: free } : {}),
      };
    });
  }, [stations, pendingPositions, autoPositions, pendingFree]);

  // The lot and transformers in use: the pending edits, else the stored
  // settings, else the default lot grown to hold the stations.
  const layoutSettings = useMemo(
    () =>
      pendingSettings ??
      effectiveLayoutSettings(
        site?.layoutSettings,
        placedStations.map((s) => positionToBay({ x: s.positionX, y: s.positionY })),
        layoutStationCountsOf(placedStations),
      ),
    [pendingSettings, site, placedStations],
  );

  const siteType = siteTypeOf(layoutSettings);
  const officeRetail = siteType === 'office_retail';
  const curbside = siteType === 'curbside';
  const custom = usesFreePositions(layoutSettings);
  const depot = siteType === 'depot';
  // The AC chargers' legend name: wall boxes on an office or retail facade,
  // posts at a street curb, pedestals otherwise.
  const acLegend = curbside
    ? t('sites.layoutView.acPost')
    : officeRetail && chargerMountingOf(layoutSettings) === 'wall'
      ? t('sites.layoutView.acWallBox')
      : t('sites.layoutView.acPedestal');

  // A pending lot moves the stations outside it to the nearest free spots, as
  // the save will (the same rule as the API).
  const resolvedStations = useMemo(() => {
    if (pendingSettings == null) return placedStations;
    const fit = fitPositionsToGrid(
      placedStations.map((s) => ({
        key: s.id,
        position: { x: s.positionX, y: s.positionY },
        kind: stationLayoutKindOf(s),
      })),
      pendingSettings,
    );
    if (fit.moved.size === 0) return placedStations;
    return placedStations.map((s) => {
      const moved = fit.moved.get(s.id);
      return moved == null ? s : { ...s, positionX: moved.x, positionY: moved.y };
    });
  }, [placedStations, pendingSettings]);

  const lotTooSmall =
    pendingSettings != null && layoutCapacity(pendingSettings) < resolvedStations.length;
  const hasPending = pendingPositions.size > 0 || pendingFree.size > 0 || pendingSettings != null;
  // Custom site: every station's free position and spots (2D view and Save).
  const freePlaces = useMemo(
    () => (custom ? freeStationPlaces(resolvedStations) : null),
    [custom, resolvedStations],
  );

  // A replayed moment draws through the same views as live data.
  const replayLast = replay.data != null ? replayLastMinute(replay.data) : 0;
  const frame = useMemo(
    () =>
      replay.data == null
        ? null
        : replayFrame(replay.data, resolvedStations, replayMoment(replay.data, replayMinute)),
    [replay.data, resolvedStations, replayMinute],
  );
  const shownStations = replaying && frame != null ? frame.stations : resolvedStations;
  const shownPower = replaying && frame != null ? frame.power : stationPowerMap;
  // The legend lists only what this view draws at this site.
  const legend = useMemo(
    () =>
      layoutLegend({
        stations: shownStations,
        settings: layoutSettings,
        show3d,
        reservationsEnabled: site?.reservationsEnabled,
      }),
    [shownStations, layoutSettings, show3d, site],
  );

  function startReplay(): void {
    setEditing(false);
    setReplayDate(localDate(Date.now()));
    setReplayMinute(0);
    setReplayPlaying(false);
  }

  function stopReplay(): void {
    setReplayDate(null);
    setReplayPlaying(false);
  }

  const selected2dStation = show3d
    ? null
    : (shownStations.find((s) => s.id === selected2d) ?? null);

  // The 2D popup stands beside its card, inside the visible part of the board.
  useLayoutEffect(() => {
    const popup = popup2dRef.current;
    const board = boardRef.current;
    if (popup == null || board == null || selected2dStation == null) return;
    // Beside the station's standard card: a custom site's card at its charger
    // point, a depot's card in its bay or lane slot, else the card's grid position.
    const place = freePlaces?.get(selected2dStation.id);
    const depotBay = depot
      ? depotStationBays(shownStations, layoutSettings).get(selected2dStation.id)
      : undefined;
    const customCard =
      place != null && freePlaces != null
        ? customCardPositions(
            shownStations,
            freePlaces,
            customBoardGeometry([...freePlaces.values()]),
          ).get(selected2dStation.id)
        : undefined;
    const corner =
      customCard != null
        ? { x: customCard.x - LAYOUT_CARD_WIDTH / 2, y: customCard.y - LAYOUT_CARD_HEIGHT / 2 }
        : depotBay != null
          ? bayToPosition(depotBay)
          : { x: selected2dStation.positionX, y: selected2dStation.positionY };
    const x = corner.x;
    const y = corner.y;
    const w = LAYOUT_CARD_WIDTH;
    const h = LAYOUT_CARD_HEIGHT;
    placeLayoutPopup(
      popup,
      { left: x, top: y, right: x + w, bottom: y + h },
      {
        left: board.scrollLeft,
        top: board.scrollTop,
        width: board.clientWidth,
        height: board.clientHeight,
      },
      8,
    );
  }, [selected2dStation, freePlaces, depot, shownStations, layoutSettings]);

  // Dual-port AC pedestals hold their partner spot, DC split systems a spot
  // per dispenser, and the accessible charging space its access aisle
  // (`heldSpots`); the 2D board marks them.
  const placedSlots = useMemo(
    () =>
      resolvedStations.map((s) => ({
        id: s.id,
        stationId: s.stationId,
        x: s.positionX,
        y: s.positionY,
        charging: s.chargingKind,
        pair: sharesSpotPair(stationLayoutKindOf(s), layoutSettings),
        span: splitDispenserCount(stationLayoutKindOf(s), layoutSettings),
      })),
    [resolvedStations, layoutSettings],
  );
  const heldMarkers = useMemo(() => {
    const markers: Array<{ key: string; x: number; y: number; label: string }> = [];
    for (const p of placedSlots) {
      // A split system's other dispensers, one spot each.
      if (p.span > 1) {
        const spots = spanSpots(positionToBay(p), p.span, layoutSettings) ?? [];
        spots.slice(1).forEach((b, i) => {
          markers.push({
            key: `split-${p.id}-${String(i + 2)}`,
            ...bayToPosition(b),
            label: t('sites.layoutView.splitDispenserSpot', { station: p.stationId, n: i + 2 }),
          });
        });
        continue;
      }
      if (!p.pair) continue;
      const partner = spotPairPartner(positionToBay(p), layoutSettings);
      if (partner == null) continue;
      markers.push({
        key: `pair-${p.id}`,
        ...bayToPosition(partner),
        label: t('sites.layoutView.pedestalSecondSpot', { station: p.stationId }),
      });
    }
    const access = accessibleChargingSpace(placedSlots, layoutSettings);
    if (access != null) {
      markers.push({
        key: 'access-aisle',
        ...bayToPosition(access.aisle),
        label: t('sites.layoutView.accessAisle'),
      });
    }
    return markers;
  }, [placedSlots, layoutSettings, t]);

  // A 2D drop lands on the 20 px grid, inside the board and on no other card,
  // pedestal partner spot or access aisle.
  const resolveDrop = useCallback(
    (stationId: string, x: number, y: number) => {
      const held = heldSpots(
        placedSlots.filter((p) => p.id !== stationId),
        layoutSettings,
      );
      const others = [
        ...resolvedStations
          .filter((s) => s.id !== stationId)
          .map((s) => ({ x: s.positionX, y: s.positionY })),
        ...[...held.keys()].map((k) => {
          const [col, row] = k.split(':').map(Number);
          return bayToPosition({ col: col ?? 0, row: row ?? 0 });
        }),
      ];
      const own = resolvedStations.find((s) => s.id === stationId);
      // Cards land inside the lot, as stations do in 3D.
      return resolveCardDrop(
        { x, y },
        others,
        gridBoardExtent(layoutSettings),
        own != null ? { x: own.positionX, y: own.positionY } : { x: 0, y: 0 },
      );
    },
    [resolvedStations, layoutSettings, placedSlots],
  );

  function chooseView(next: LayoutView): void {
    setView(next);
    storeView(next);
    if (next === '2d') setEditing(false);
    setSelected2d(null);
  }

  function handleDragEnd(stationId: string, x: number, y: number): void {
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(stationId, { x, y });
      return next;
    });
  }

  // A transformer dropped in 3D (already on the grass).
  function handleTransformerMove(transformerId: string, x: number, z: number): void {
    const base = layoutSettings;
    const spot = snapTransformerToGrass(x, z, base);
    setPendingSettings({
      ...base,
      transformers: base.transformers.map((tr) =>
        tr.id === transformerId ? { ...tr, ...spot } : tr,
      ),
    });
  }

  // A battery dropped in 3D (already on the grass).
  function handleEnergyAssetMove(assetId: string, x: number, z: number): void {
    const base = layoutSettings;
    const spot = snapTransformerToGrass(x, z, base);
    setPendingSettings({
      ...base,
      energyAssets: energyAssetsOf(base).map((a) =>
        a.id === assetId && a.type === 'battery' ? { ...a, ...spot } : a,
      ),
    });
  }

  // A station of a custom site moved or turned (3D drag, handle or keys, or the 2D board).
  function handleFreeMove(stationId: string, placement: FreePlacement): void {
    setPendingFree((prev) => new Map(prev).set(stationId, placement));
  }

  // A solar canopy of a custom site moved or turned.
  function handleSolarMove(assetId: string, placement: FreePlacement): void {
    const base = layoutSettings;
    setPendingSettings({
      ...base,
      energyAssets: energyAssetsOf(base).map((a) =>
        a.id === assetId && a.type === 'solar'
          ? { ...a, x: placement.x, z: placement.z, rotationDeg: placement.rotationDeg }
          : a,
      ),
    });
  }

  function handleSave(): void {
    // A custom site saves every station's free position (a picked one is stored too).
    const positions = resolvedStations.map((s) => {
      const free = freePlaces?.get(s.id)?.placement;
      return {
        stationId: s.id,
        positionX: s.positionX,
        positionY: s.positionY,
        ...(free != null ? { freePosition: free } : {}),
      };
    });
    saveMutation.mutate(
      pendingSettings != null ? { positions, settings: pendingSettings } : { positions },
    );
    setSelected2d(null);
  }

  function handleReset(): void {
    setPendingPositions(new Map());
    setPendingFree(new Map());
    setPendingSettings(null);
    setSettingsInvalid(false);
    setSettingsPanelKey((k) => k + 1);
    setSelected2d(null);
  }

  // The day replay bar: above the stage, or inside it while the 3D view is full screen.
  const replayBar =
    replayDate != null ? (
      <LayoutReplayBar
        date={replayDate}
        onDateChange={(date) => {
          setReplayDate(date);
          setReplayMinute(0);
          setReplayPlaying(false);
        }}
        minute={replayMinute}
        onMinuteChange={setReplayMinute}
        lastMinute={replayLast}
        playing={replayPlaying}
        onPlayingChange={setReplayPlaying}
        speed={replaySpeed}
        onSpeedChange={setReplaySpeed}
        isLoading={replay.isLoading}
        isError={replay.isError}
        onRetry={() => {
          void replay.refetch();
        }}
        onExit={stopReplay}
      />
    ) : null;

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
          {resolvedStations.length > 0 && !editing && !replaying && (
            <Button
              type="button"
              variant="outline"
              data-testid="site-layout-replay-toggle"
              onClick={startReplay}
            >
              <History className="h-4 w-4" />
              {t('sites.layoutView.replayDayButton')}
            </Button>
          )}
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
          {show3d && canWrite && resolvedStations.length > 0 && !replaying && (
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
              <ResetButton onClick={handleReset} disabled={!hasPending} />
              <SaveButton
                isPending={saveMutation.isPending}
                disabled={saveMutation.isPending || settingsInvalid || lotTooSmall}
              />
            </form>
          )}
        </div>
      }
    >
      {saveMutation.isError && (
        <p className="mb-3 text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
      )}
      {!(stageFullScreen && show3d) && replayBar}
      {show3d && editing && canWrite && resolvedStations.length > 0 && (
        <LayoutSettingsPanel
          key={settingsPanelKey}
          siteId={siteId}
          settings={layoutSettings}
          stationCount={resolvedStations.length}
          onChange={setPendingSettings}
          onInvalidChange={setSettingsInvalid}
        />
      )}
      {!canWrite && resolvedStations.length > 0 && !replaying && (
        // Without write access the power equipment opens read-only.
        <div className="mb-3">
          <PowerEquipmentField siteId={siteId} settings={layoutSettings} />
        </div>
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
            <div
              data-testid="site-layout-3d-loading"
              className={cn('flex w-full items-center justify-center', STAGE_HEIGHT_CLASS)}
            >
              <LoadingLogo size="inline" label={t('sites.layoutView.loading3d')} />
            </div>
          }
        >
          <SiteLayout3D
            stations={shownStations}
            settings={layoutSettings}
            terminals={terminals}
            hierarchy={loadManagement?.hierarchy ?? null}
            loadManaged={loadManagement?.config?.isEnabled === true}
            logoUrl={logoUrl}
            california={site != null && isCaliforniaSite(site)}
            insights={insights}
            onTransformerMove={handleTransformerMove}
            onEnergyAssetMove={handleEnergyAssetMove}
            onFreeMove={handleFreeMove}
            onSolarMove={handleSolarMove}
            editing={editing && canWrite}
            fitKey={fitKey}
            currentDrawKw={(id) => shownPower.get(id)?.currentDrawKw}
            allocatedLimitKw={(id) => shownPower.get(id)?.allocatedLimitKw}
            replaying={replaying}
            fullScreenFooter={replayBar}
            onFullScreenChange={setStageFullScreen}
            onMove={handleDragEnd}
            onUnavailable={() => {
              setWebgl(false);
              setEditing(false);
            }}
          />
        </Suspense>
      ) : (
        // The power draw strip sits above the board at every width, so it never covers a
        // station card.
        <div className="relative">
          {loadManagement != null && loadManagement.stations.length > 0 && (
            <div
              data-testid="site-layout-power-draw"
              className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs shadow-xs"
            >
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <Zap className="h-3.5 w-3.5" />
                {t('sites.powerDraw')}
              </div>
              <div className="flex gap-2">
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
                <div className="flex gap-2">
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
          {custom && freePlaces != null ? (
            <CustomLayoutBoard
              stations={shownStations}
              places={freePlaces}
              power={shownPower}
              boardRef={boardRef}
              onMove={handleFreeMove}
              onOpenDetails={setSelected2d}
            >
              {selected2dStation != null && (
                <StationLayoutPopup
                  ref={popup2dRef}
                  station={selected2dStation}
                  currentDrawKw={shownPower.get(selected2dStation.id)?.currentDrawKw}
                  allocatedLimitKw={shownPower.get(selected2dStation.id)?.allocatedLimitKw}
                  terminals={terminals.get(selected2dStation.id)}
                  onClose={() => {
                    setSelected2d(null);
                  }}
                />
              )}
            </CustomLayoutBoard>
          ) : depot ? (
            <DepotLayoutBoard
              stations={shownStations}
              settings={layoutSettings}
              power={shownPower}
              boardRef={boardRef}
              editable={canWrite && !replaying}
              onMove={handleDragEnd}
              onOpenDetails={setSelected2d}
            >
              {selected2dStation != null && (
                <StationLayoutPopup
                  ref={popup2dRef}
                  station={selected2dStation}
                  currentDrawKw={shownPower.get(selected2dStation.id)?.currentDrawKw}
                  allocatedLimitKw={shownPower.get(selected2dStation.id)?.allocatedLimitKw}
                  terminals={terminals.get(selected2dStation.id)}
                  onClose={() => {
                    setSelected2d(null);
                  }}
                />
              )}
            </DepotLayoutBoard>
          ) : (
            <div
              ref={boardRef}
              data-testid="site-layout-2d"
              className="relative w-full h-[700px] border-2 border-dashed rounded-lg overflow-auto"
            >
              {/* An office or retail site: the building edge along the first row. */}
              {officeRetail && (
                <div
                  aria-hidden="true"
                  data-testid="site-layout-2d-building"
                  className="pointer-events-none absolute rounded-sm bg-muted-foreground/50"
                  style={{
                    left: 8,
                    top: 0,
                    width: gridBoardExtent(layoutSettings).width + 12,
                    height: 6,
                  }}
                />
              )}
              {curbside ? (
                <CurbsideBoard settings={layoutSettings} />
              ) : (
                // The paved lot: cards land inside it.
                <div
                  aria-hidden="true"
                  data-testid="site-layout-2d-lot"
                  className="pointer-events-none absolute rounded-md border border-dashed border-primary/40 bg-muted/40"
                  style={{
                    left: 8,
                    top: 8,
                    width: gridBoardExtent(layoutSettings).width + 12,
                    height: gridBoardExtent(layoutSettings).height + 12,
                  }}
                />
              )}
              {heldMarkers.map((m) => (
                <div
                  key={m.key}
                  aria-hidden="true"
                  data-testid={`site-layout-2d-held-${m.key}`}
                  className="pointer-events-none absolute flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/50 p-2 text-center text-xs text-muted-foreground"
                  style={{
                    left: m.x,
                    top: m.y,
                    width: LAYOUT_CARD_WIDTH,
                    height: LAYOUT_CARD_HEIGHT,
                  }}
                >
                  {m.label}
                </div>
              ))}
              {shownStations.map((station) => {
                const power = shownPower.get(station.id);
                return (
                  <StationCard
                    key={station.id}
                    station={station}
                    onDragEnd={handleDragEnd}
                    resolveDrop={resolveDrop}
                    currentDrawKw={power?.currentDrawKw}
                    allocatedLimitKw={power?.allocatedLimitKw}
                    onOpenDetails={setSelected2d}
                  />
                );
              })}
              {selected2dStation != null && (
                <StationLayoutPopup
                  ref={popup2dRef}
                  station={selected2dStation}
                  currentDrawKw={shownPower.get(selected2dStation.id)?.currentDrawKw}
                  allocatedLimitKw={shownPower.get(selected2dStation.id)?.allocatedLimitKw}
                  terminals={terminals.get(selected2dStation.id)}
                  onClose={() => {
                    setSelected2d(null);
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
      {custom && !show3d && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="site-layout-2d-custom-hint">
          {t('sites.layoutView.hintEditCustom')}
        </p>
      )}
      {depot && !show3d && canWrite && !replaying && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="site-layout-2d-depot-hint">
          {t('sites.layoutView.hintDepot2d')}
        </p>
      )}
      <div
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        data-testid="site-layout-state-legend"
      >
        {legend.ac && (
          <span className="flex items-center gap-1" data-testid="site-layout-ac-legend">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: SCENE_COLORS.ac }}
            />
            {acLegend}
          </span>
        )}
        {legend.dc && (
          <span className="flex items-center gap-1" data-testid="site-layout-dc-legend">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: SCENE_COLORS.dc }}
            />
            {t('sites.layoutView.dcCharger')}
          </span>
        )}
        {legend.battery && (
          <span className="flex items-center gap-1" data-testid="site-layout-battery-legend">
            <span
              className="inline-block h-3 w-3 rounded-sm border"
              style={{ backgroundColor: SCENE_COLORS.light.battery }}
            />
            {t('sites.layoutView.battery')}
          </span>
        )}
        {legend.solar && (
          <span className="flex items-center gap-1" data-testid="site-layout-solar-legend">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: SCENE_COLORS.light.solarCell }}
            />
            {t('sites.layoutView.solarCanopy')}
          </span>
        )}
        {legend.building && (
          <span className="flex items-center gap-1" data-testid="site-layout-building-legend">
            <span className="inline-block h-1.5 w-4 rounded-sm bg-muted-foreground/50" />
            {t('sites.layoutView.building')}
          </span>
        )}
        {legend.carSpot && (
          <span className="flex items-center gap-1" data-testid="site-layout-spot-legend">
            <span className="inline-block h-3 w-2 rounded-sm border border-dashed border-primary/60 bg-muted/70" />
            {t('sites.layoutView.parkingSpot')}
          </span>
        )}
        {legend.busBay && (
          <span className="flex items-center gap-1" data-testid="site-layout-bus-bay-legend">
            <span className="inline-block h-3 w-2 rounded-sm border border-primary/60 bg-muted/70" />
            {t('sites.layoutView.busBay')}
          </span>
        )}
        {legend.truckLane && (
          <span className="flex items-center gap-1" data-testid="site-layout-truck-lane-legend">
            <span className="inline-block h-2 w-4 rounded-sm border border-primary/60 bg-muted/70" />
            {t('sites.layoutView.truckLane')}
          </span>
        )}
        {legend.street && (
          <span className="flex items-center gap-1" data-testid="site-layout-street-legend">
            <span className="inline-block h-1.5 w-4 rounded-sm bg-muted-foreground/40" />
            {t('sites.layoutView.street')}
          </span>
        )}
        <StationStateLegend states={legend.states} />
        <ConnectionLegend types={legend.connections} signal={legend.signal} />
      </div>
    </TabPanel>
  );
}

/** Row y on the 2D board where a curbside side's cards start. */
function rowTop(row: number): number {
  return LAYOUT_PADDING + row * LAYOUT_SPACING_Y;
}

/**
 * The 2D street of a curbside site: the left side (row 0) and the right side
 * (row 1) outlined, each as long as its chargers (a side without chargers has
 * no outline), with the street between them in the gap of the two rows.
 */
function CurbsideBoard({ settings }: { settings: SiteLayoutSettings }): React.JSX.Element {
  const [left = 0, right = 0] = layoutRowLengths(settings);
  const width = gridBoardExtent(settings).width + 12;
  const sideWidth = (n: number): number =>
    LAYOUT_PADDING + (n - 1) * LAYOUT_SPACING_X + LAYOUT_CARD_WIDTH + 12;
  const cardBottom = rowTop(0) + LAYOUT_CARD_HEIGHT;
  const streetTop = cardBottom + 4;
  const streetHeight = rowTop(1) - 4 - streetTop;
  return (
    <>
      {left > 0 && (
        <div
          aria-hidden="true"
          data-testid="site-layout-2d-side-left"
          className="pointer-events-none absolute rounded-md border border-dashed border-primary/40 bg-muted/40"
          style={{ left: 8, top: 8, width: sideWidth(left), height: cardBottom + 4 - 8 }}
        />
      )}
      <div
        aria-hidden="true"
        data-testid="site-layout-2d-street"
        className="pointer-events-none absolute flex items-center rounded-sm bg-muted-foreground/40"
        style={{ left: 0, top: streetTop, width: width + 16, height: streetHeight }}
      >
        <span className="mx-2 block w-full border-t-2 border-dashed border-background/80" />
      </div>
      {right > 0 && (
        <div
          aria-hidden="true"
          data-testid="site-layout-2d-side-right"
          className="pointer-events-none absolute rounded-md border border-dashed border-primary/40 bg-muted/40"
          style={{
            left: 8,
            top: rowTop(1) - 4,
            width: sideWidth(right),
            height: LAYOUT_CARD_HEIGHT + 8,
          }}
        />
      )}
    </>
  );
}
