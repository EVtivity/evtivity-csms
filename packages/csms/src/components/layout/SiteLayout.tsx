// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useCallback, useLayoutEffect, useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Zap, Maximize2, Pencil, Check, History } from 'lucide-react';
import {
  chargerMountingOf,
  effectiveLayoutSettings,
  energyAssetsOf,
  layoutCapacity,
  layoutRowLengths,
  siteTypeOf,
  fitPositionsToGrid,
  positionToBay,
  snapTransformerToGrass,
  usesFreePositions,
  type FreePlacement,
  type LayoutEnergyAssetPosition,
  type LayoutPowerEquipment,
  type SiteLayoutSettings,
  NO_POWER_EQUIPMENT,
  placePowerEquipment,
  layoutStationPlaces,
  heldSpots,
  settlePairs,
  sharesSpotPair,
  splitDispenserCount,
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
import type { LayoutStation } from './StationCard';
import { StationLayoutPopup } from './StationLayoutPopup';
import { placeLayoutPopup } from './layout-popup-position';
import { STAGE_HEIGHT_CLASS } from './site-layout-stage';
import { cn } from '@/lib/utils';
import { ConnectionLegend, StationStateLegend } from './StationStateIcon';
import { SCENE_COLORS } from './site-layout-colors';
import { LayoutSettingsPanel } from './LayoutSettingsPanel';
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
import { freeStationPlaces, layoutStationCountsOf, stationLayoutKindOf } from './site-layout-free';
import { isCaliforniaSite } from './site-layout-signs';
import { layoutLegend } from './site-layout-legend';
import { StationCardBoard } from './StationCardBoard';
import { stationBays } from './site-layout-2d-bays';
import {
  bayKey,
  customCardLayout,
  depotCardLayout,
  gridCardLayout,
  type CardLayout,
} from './site-layout-2d-placement';
import type { BoardPoint } from './site-layout-2d-board';
import { StationCardContext, type StationCardExtras } from './station-card-context';
import { stationThumbnailModel } from './site-layout-station-thumbnail';
import { useChargerPlateColors } from './use-station-thumbnail';

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
  // Custom site: stations moved or turned in Edit Layout, saved with Save.
  const [pendingFree, setPendingFree] = useState<Map<string, FreePlacement>>(new Map());
  // Cards moved on the 2D board (board px), saved with Save; never their 3D spots.
  const [pendingBoard, setPendingBoard] = useState<Map<string, BoardPoint>>(new Map());
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
        powerEquipment?: LayoutPowerEquipment;
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
        boardPosition?: BoardPoint;
      }>;
      settings?: SiteLayoutSettings;
    }) => api.put(`/v1/sites/${siteId}/layout`, body),
    // A saved layout leaves Edit Layout; a failed save keeps the mode and the
    // pending positions and settings, and shows the error.
    onSuccess: () => {
      setEditing(false);
      setPendingPositions(new Map());
      setPendingBoard(new Map());
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
  // The site's power equipment rows at their positions: what the 3D view
  // draws and labels (the layout settings hold positions by id only).
  const equipment = site?.powerEquipment ?? NO_POWER_EQUIPMENT;
  const placedSettings = useMemo(
    () =>
      placePowerEquipment(
        layoutSettings,
        equipment,
        // A transformer without a stored position stands next to the stations it feeds.
        layoutStationPlaces(placedStations, layoutSettings),
      ),
    [layoutSettings, equipment, placedStations],
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
  const hasPending =
    pendingPositions.size > 0 ||
    pendingFree.size > 0 ||
    pendingBoard.size > 0 ||
    pendingSettings != null;
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
        settings: placedSettings,
        show3d,
        reservationsEnabled: site?.reservationsEnabled,
      }),
    [shownStations, placedSettings, show3d, site],
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

  // The 2D cards' picture model (by the site type's rules) and paired terminals.
  const plateColors = useChargerPlateColors();
  const cardExtras = useMemo<StationCardExtras>(
    () => ({
      thumbnailModel: (station) => stationThumbnailModel(station, layoutSettings),
      terminals: (stationId) => terminals.get(stationId) ?? [],
      plateColors,
    }),
    [layoutSettings, terminals, plateColors],
  );

  const selected2dStation = show3d
    ? null
    : (shownStations.find((s) => s.id === selected2d) ?? null);

  // The 2D popup stands beside its card, inside the visible part of the board.
  useLayoutEffect(() => {
    const popup = popup2dRef.current;
    const board = boardRef.current;
    if (popup == null || board == null || selected2dStation == null) return;
    const card = board.querySelector<HTMLElement>(
      `[data-testid="site-layout-card-${selected2dStation.id}"]`,
    );
    if (card == null) return;
    const c = card.getBoundingClientRect();
    const o = board.getBoundingClientRect();
    const left = c.left - o.left + board.scrollLeft;
    const top = c.top - o.top + board.scrollTop;
    placeLayoutPopup(
      popup,
      { left, top, right: left + c.width, bottom: top + c.height },
      {
        left: board.scrollLeft,
        top: board.scrollTop,
        width: board.clientWidth,
        height: board.clientHeight,
      },
      8,
    );
  }, [selected2dStation, shownStations, layoutSettings]);

  // Dual-port AC pedestals and dual-outlet DC dispensers hold their partner spot, DC split systems a spot
  // per dispenser, and the accessible charging space its access aisle
  // (`heldSpots`); the 2D board marks them.
  const placedSlots = useMemo(
    () =>
      // A pair holds only while its partner spot is free (`settlePairs`).
      settlePairs(
        resolvedStations.map((s) => ({
          id: s.id,
          stationId: s.stationId,
          x: s.positionX,
          y: s.positionY,
          charging: s.chargingKind,
          pair: sharesSpotPair(stationLayoutKindOf(s), layoutSettings),
          span: splitDispenserCount(stationLayoutKindOf(s), layoutSettings),
        })),
        layoutSettings,
      ),
    [resolvedStations, layoutSettings],
  );
  // The 2D card layout of the site type (`site-layout-2d-placement.ts`): a
  // grid site's spots (the held spots of pedestals, split systems and the
  // access aisle are no slots), a depot's bays and lanes wrapping to the
  // board, a custom site's free positions in spatial order.
  const blockedSpots = useMemo(() => {
    const keys = new Set<string>();
    for (const p of placedSlots) {
      const held = heldSpots([p], layoutSettings);
      const own = positionToBay({ x: p.x, y: p.y });
      for (const k of held.keys()) if (k !== bayKey(own.col, own.row)) keys.add(k);
    }
    return keys;
  }, [placedSlots, layoutSettings]);
  const cardLayoutFor = useCallback(
    (boardWidth: number): CardLayout => {
      if (custom && freePlaces != null) {
        return customCardLayout(
          shownStations.flatMap((s) => {
            const place = freePlaces.get(s.id);
            return place == null ? [] : [{ id: s.id, x: place.placement.x, z: place.placement.z }];
          }),
        );
      }
      const bays = stationBays(shownStations, layoutSettings);
      const list = shownStations.flatMap((s) => {
        const bay = bays.get(s.id);
        return bay == null ? [] : [{ id: s.id, bay }];
      });
      return depot
        ? depotCardLayout(list, layoutRowLengths(layoutSettings), boardWidth)
        : gridCardLayout(list, layoutRowLengths(layoutSettings), blockedSpots);
    },
    [custom, depot, freePlaces, shownStations, layoutSettings, blockedSpots],
  );
  // Each card's 2D board position: a pending move, else the saved one.
  const boardPoints = useMemo(
    () =>
      new Map(shownStations.map((s) => [s.id, pendingBoard.get(s.id) ?? s.boardPosition ?? null])),
    [shownStations, pendingBoard],
  );

  function handleBoardMove(stationId: string, point: BoardPoint): void {
    setPendingBoard((prev) => new Map(prev).set(stationId, point));
  }

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
  // A transformer dropped in 3D (already on the grass); one without a stored
  // position gets one.
  function handleTransformerMove(transformerId: string, x: number, z: number): void {
    const base = layoutSettings;
    const spot = snapTransformerToGrass(x, z, base);
    const others = base.transformers.filter((tr) => tr.id !== transformerId);
    const known = others.length < base.transformers.length;
    setPendingSettings({
      ...base,
      transformers: known
        ? base.transformers.map((tr) => (tr.id === transformerId ? { id: tr.id, ...spot } : tr))
        : [...base.transformers, { id: transformerId, ...spot }],
    });
  }

  /** The energy asset positions with one asset's position changed (added when it had none). */
  function withAssetPosition(
    base: SiteLayoutSettings,
    assetId: string,
    change: Omit<LayoutEnergyAssetPosition, 'id'>,
  ): LayoutEnergyAssetPosition[] {
    const assets = energyAssetsOf(base);
    return assets.some((a) => a.id === assetId)
      ? assets.map((a) => (a.id === assetId ? { ...a, ...change } : a))
      : [...assets, { id: assetId, ...change }];
  }

  // A battery dropped in 3D (already on the grass).
  function handleEnergyAssetMove(assetId: string, x: number, z: number): void {
    const base = layoutSettings;
    const spot = snapTransformerToGrass(x, z, base);
    setPendingSettings({ ...base, energyAssets: withAssetPosition(base, assetId, spot) });
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
      energyAssets: withAssetPosition(base, assetId, {
        x: placement.x,
        z: placement.z,
        rotationDeg: placement.rotationDeg,
      }),
    });
  }

  function handleSave(): void {
    // A custom site saves every station's free position (a picked one is stored too).
    const positions = resolvedStations.map((s) => {
      const free = freePlaces?.get(s.id)?.placement;
      const board = pendingBoard.get(s.id);
      return {
        stationId: s.id,
        positionX: s.positionX,
        positionY: s.positionY,
        ...(free != null ? { freePosition: free } : {}),
        ...(board != null
          ? { boardPosition: { x: Math.round(board.x), y: Math.round(board.y) } }
          : {}),
      };
    });
    saveMutation.mutate(
      pendingSettings != null ? { positions, settings: pendingSettings } : { positions },
    );
    setSelected2d(null);
  }

  function handleReset(): void {
    setPendingPositions(new Map());
    setPendingBoard(new Map());
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
          equipment={equipment}
          stationCount={resolvedStations.length}
          onChange={setPendingSettings}
          onInvalidChange={setSettingsInvalid}
        />
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
            settings={placedSettings}
            terminals={terminals}
            hierarchy={loadManagement?.hierarchy ?? null}
            equipment={equipment}
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
            liveOcppSiteId={replaying ? undefined : siteId}
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
          <StationCardContext value={cardExtras}>
            <StationCardBoard
              stations={shownStations}
              layoutFor={cardLayoutFor}
              editable={canWrite && !replaying}
              power={shownPower}
              boardRef={boardRef}
              onOpenDetails={setSelected2d}
              positions={boardPoints}
              onMove={handleBoardMove}
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
            </StationCardBoard>
          </StationCardContext>
        </div>
      )}
      {!show3d && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="site-layout-2d-hint">
          {t(
            canWrite && !replaying
              ? 'sites.layoutView.board2d.hint'
              : 'sites.layoutView.board2d.hintViewOnly',
          )}
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
              style={{ backgroundColor: plateColors.ac }}
            />
            {acLegend}
          </span>
        )}
        {legend.dc && (
          <span className="flex items-center gap-1" data-testid="site-layout-dc-legend">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: plateColors.dc }}
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
