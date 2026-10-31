// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 3D view of the site Layout tab and of the dashboard Site Layout widget
// (view only). Both load it with React.lazy, so three.js
// (site-layout-scene.ts) is fetched only when a 3D view shows.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { List, Sparkles, User, X } from 'lucide-react';
import {
  assignBays,
  bayToPosition,
  energyAssetsOf,
  nearestFreeBay,
  positionToBay,
  showsSolar,
  showsTransformers,
  snapTransformerToGrass,
  type LayoutBay,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import {
  resolveCssColor,
  stationDisplayState,
  stationStateColor,
  stationStateLabelKey,
  stationStateTextColor,
} from '@/lib/station-display-state';
import { formatNumber } from '@/lib/formatting';
import { Button } from '@/components/ui/button';
import {
  createSiteScene,
  type SceneCameraView,
  type SceneStation,
  type ScreenPoint,
  type SiteScene,
} from './site-layout-scene';
import type { LayoutStation } from './StationCard';
import {
  lotOf,
  stationBackPoint,
  stationLabelInRange,
  stationProp,
  wallMounted,
  type Point,
} from './site-layout-grid';
import {
  loadFlows,
  loadLevel,
  loadLinks,
  placePanels,
  type FlowLoad,
  type LinkLabel,
  type LinkPanel,
} from './site-layout-links';
import { AccountAvatar } from '@/components/AccountAvatar';
import type { LayoutInsight } from './site-layout-data';
import { SessionLayoutPopup, splitDriverName } from './SessionLayoutPopup';
import {
  LayoutStationList,
  LayoutSummaryChip,
  nextStationInState,
  type SummaryState,
} from './LayoutStationList';
import { terminalSide, type LayoutTerminal } from './layout-terminals';
import { StationLayoutPopup } from './StationLayoutPopup';
import { placeLayoutPopup } from './layout-popup-position';
import { STAGE_HEIGHT_CLASS } from './site-layout-stage';
import { cn } from '@/lib/utils';
import { CellularBadge } from './StationStateIcon';

export interface SiteLayout3DProps {
  stations: readonly LayoutStation[];
  /** The site type, the lot and the transformers (effective settings, pending edits included). */
  settings: SiteLayoutSettings;
  /** Payment terminals paired to each station (by internal station ID). */
  terminals: ReadonlyMap<string, readonly LayoutTerminal[]>;
  /** The load management hierarchy when the site is load managed, else null (no panels, no links). */
  hierarchy: readonly LinkPanel[] | null;
  /** The company logo for the back panels of the chargers. */
  logoUrl: string | null;
  /** Edit mode: drag stations to free spots and transformers on the grass (only with sites:write). */
  editing: boolean;
  /** Bumped by Fit to View. */
  fitKey: number;
  currentDrawKw: (stationId: string) => number | undefined;
  allocatedLimitKw: (stationId: string) => number | null | undefined;
  onMove: (stationId: string, x: number, y: number) => void;
  onTransformerMove: (transformerId: string, x: number, z: number) => void;
  /** A battery dragged on the grass in edit mode (lot meters, already on the grass). */
  onEnergyAssetMove?: (assetId: string, x: number, z: number) => void;
  /** The browser could not create a WebGL context: the parent shows the 2D view. */
  onUnavailable: () => void;
  /** Where Fit to View puts the camera (default `overview`). */
  cameraView?: SceneCameraView;
  /** The stage height classes (default: the Layout tab stage). */
  stageClassName?: string;
  /** Renders while true (default); false pauses the frame loop (off screen). A hidden tab pauses it too. */
  active?: boolean;
  /** View only (the dashboard): the hint names no editing. Pass `editing` false too. */
  viewOnly?: boolean;
  /** Open AI insights by internal station id (only with aiInsights:read). */
  insights?: ReadonlyMap<string, readonly LayoutInsight[]> | undefined;
  /** A replayed day shows (Layout tab): no live session avatars, insights or popups of today. */
  replaying?: boolean;
}

/** The bar color of a panel's live draw against its limit. */
const LOAD_BAR_CLASS = {
  normal: 'bg-success',
  near: 'bg-warning',
  at: 'bg-destructive',
} as const;

/** The live draw of a panel against its limit: a small bar in its label. */
function PanelLoadBar({ load }: { load: FlowLoad }): React.JSX.Element {
  const { t } = useTranslation();
  const level = loadLevel(load.drawKw, load.limitKw);
  const pct =
    load.limitKw != null && load.limitKw > 0
      ? Math.min(100, Math.round((load.drawKw / load.limitKw) * 100))
      : 0;
  return (
    <span
      className="mt-0.5 block h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={t('sites.layoutView.panelLoad', {
        draw: formatNumber(load.drawKw, 1),
        limit: load.limitKw != null ? formatNumber(load.limitKw, 1) : '-',
      })}
      data-level={level}
      data-testid="panel-load-bar"
    >
      <span
        className={cn('block h-full', LOAD_BAR_CLASS[level])}
        style={{ width: `${String(pct)}%` }}
      />
    </span>
  );
}

/**
 * The spot of every station: its 2D slot, or the nearest free spot when
 * another holds it. A station below or beside the lot keeps its slot there.
 */
export function stationBays(
  stations: readonly LayoutStation[],
  settings: SiteLayoutSettings,
): Map<string, LayoutBay> {
  const cols = Math.max(
    settings.spotsPerRow,
    ...stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY }).col + 1),
  );
  const assigned = assignBays(
    stations.map((s) => ({ x: s.positionX, y: s.positionY })),
    cols,
  );
  const bays = new Map<string, LayoutBay>();
  stations.forEach((s, i) => {
    const bay = assigned[i];
    if (bay != null) bays.set(s.id, bay);
  });
  return bays;
}

/** The text of a link label: name, breaker and limit, or a station's allocated limit. */
export function linkLabelText(label: LinkLabel): string {
  const parts: string[] = [];
  if (label.name != null) parts.push(label.name);
  if (label.amps != null) parts.push(`${formatNumber(label.amps, 0)} A`);
  if (label.kw != null) parts.push(`${formatNumber(label.kw, 1)} kW`);
  return parts.join(' · ');
}

function readTheme(reservedLabel: string) {
  return {
    reservedLabel,
    dark: document.documentElement.classList.contains('dark'),
    primary: resolveCssColor('hsl(var(--primary))'),
    destructive: resolveCssColor('hsl(var(--destructive))'),
  };
}

/** Whether the browser tab is visible; the scene pauses while it is hidden. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);
  return visible;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** The width the open station list takes from the right of the stage, in px (w-64 plus margins). */
const LIST_PANEL_SPACE_PX = 280;
type Size = { width: number; height: number };

/**
 * Places one overlay label above its point (or one row higher) where it
 * covers no placed label. `size` is the label size read before any write of
 * the frame.
 */
function placeLabel(
  el: HTMLElement,
  p: ScreenPoint | null,
  placed: Rect[],
  size: Size = { width: el.offsetWidth, height: el.offsetHeight },
  lifts: readonly number[] = [0, size.height + 4],
): void {
  let shown = false;
  if (p != null && p.visible) {
    for (const lift of lifts) {
      const y = p.y - lift;
      const rect = {
        left: p.x - size.width / 2,
        right: p.x + size.width / 2,
        top: y - size.height,
        bottom: y,
      };
      const covers = placed.some(
        (o) =>
          rect.left < o.right && o.left < rect.right && rect.top < o.bottom && o.top < rect.bottom,
      );
      if (!covers) {
        placed.push(rect);
        el.style.left = `${String(p.x)}px`;
        el.style.top = `${String(y)}px`;
        shown = true;
        break;
      }
    }
  }
  el.style.visibility = shown ? 'visible' : 'hidden';
}

export default function SiteLayout3D({
  stations,
  settings,
  terminals,
  hierarchy,
  logoUrl,
  editing,
  fitKey,
  currentDrawKw,
  allocatedLimitKw,
  onMove,
  onTransformerMove,
  onEnergyAssetMove,
  onUnavailable,
  cameraView = 'overview',
  stageClassName = STAGE_HEIGHT_CLASS,
  active = true,
  viewOnly = false,
  insights,
  replaying = false,
}: SiteLayout3DProps): React.JSX.Element {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SiteScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const transformerLabelRefs = useRef(new Map<string, HTMLDivElement>());
  const energyLabelRefs = useRef(new Map<string, HTMLDivElement>());
  const linkLabelRefs = useRef(new Map<string, HTMLDivElement>());
  const avatarRefs = useRef(new Map<string, HTMLDivElement>());
  const popupRef = useRef<HTMLDivElement>(null);
  const sessionPopupRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  // The station whose session popup shows (opened from its driver avatar).
  const [sessionStationId, setSessionStationId] = useState<string | null>(null);
  const sessionStationRef = useRef<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listOpenRef = useRef(false);
  // The popups stay left of the open station list panel (16 rem wide, 12 px from the edge).
  const popupAreaWidth = (stage: HTMLElement): number =>
    listOpenRef.current && stage.clientWidth > 600
      ? stage.clientWidth - LIST_PANEL_SPACE_PX
      : stage.clientWidth;
  const stationCountRef = useRef(stations.length);

  const pageVisible = usePageVisible();
  const lot = useMemo(() => lotOf(settings), [settings]);
  const bays = useMemo(() => stationBays(stations, settings), [stations, settings]);
  // Transformers show on a parking lot only; an office or retail site keeps them hidden.
  const transformers = useMemo(
    () => (showsTransformers(settings) ? settings.transformers : []),
    [settings],
  );
  // Batteries on both site types; solar canopies on a parking lot only.
  const energyAssets = useMemo(
    () => energyAssetsOf(settings).filter((a) => a.type === 'battery' || showsSolar(settings)),
    [settings],
  );
  // One panel model per load management panel, only while the site is load managed.
  const panels = useMemo(
    () => (hierarchy == null ? [] : placePanels(hierarchy, lot)),
    [hierarchy, lot],
  );
  const links = useMemo(() => {
    if (hierarchy == null) return { segments: [], labels: [] };
    const kinds = new Map(stations.map((s) => [s.id, s.chargingKind]));
    const points = new Map<string, Point>();
    for (const [id, bay] of bays) {
      points.set(id, stationBackPoint(bay, lot, kinds.get(id) ?? 'dc'));
    }
    return loadLinks(hierarchy, panels, points);
  }, [hierarchy, panels, bays, lot, stations]);

  // The live power on the links and the panels' draw against their limits.
  const flows = useMemo(
    () => (hierarchy == null ? null : loadFlows(hierarchy, currentDrawKw)),
    [hierarchy, currentDrawKw],
  );

  const stateRef = useRef({ bays, settings });
  const onMoveRef = useRef(onMove);
  const onTransformerMoveRef = useRef(onTransformerMove);
  const onEnergyAssetMoveRef = useRef(onEnergyAssetMove);
  const onUnavailableRef = useRef(onUnavailable);
  const reservedLabel = t('sites.layoutState.reserved');
  const reservedLabelRef = useRef(reservedLabel);

  const sceneLayout = useMemo(() => {
    const sceneStations: SceneStation[] = stations.map((s) => {
      const state = stationDisplayState(s);
      const bay = bays.get(s.id) ?? { col: 0, row: 0 };
      return {
        id: s.id,
        kind: s.chargingKind,
        bay,
        lightColor: resolveCssColor(stationStateColor(state)),
        lit: state !== 'offline',
        pulsing: state === 'charging',
        glow: state === 'charging',
        wall: wallMounted(bay, lot, s.chargingKind),
        prop: stationProp(state),
        beacon: state === 'faulted',
        terminals: (terminals.get(s.id) ?? []).map((term) => ({
          id: term.id,
          side: terminalSide(term.evseNumber),
          hasDisplay: term.hasDisplay,
          online: term.online,
        })),
      };
    });
    return {
      lot,
      stations: sceneStations,
      transformers: transformers.map((tr) => ({ id: tr.id, x: tr.x, z: tr.z })),
      batteries: energyAssets.flatMap((a) =>
        a.type === 'battery' ? [{ id: a.id, x: a.x, z: a.z }] : [],
      ),
      solar: energyAssets.flatMap((a) => (a.type === 'solar' ? [{ id: a.id, row: a.row }] : [])),
      panels: panels.map((p) => ({ id: p.id, x: p.point.x, z: p.point.z, mount: p.mount })),
      links,
    };
  }, [stations, bays, lot, transformers, energyAssets, panels, terminals, links]);
  const sceneLayoutRef = useRef(sceneLayout);
  const cameraViewRef = useRef(cameraView);

  // Create the scene once; the effects below feed it.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;
    let scene: SiteScene;
    try {
      scene = createSiteScene(
        stage,
        { reducedMotion: prefersReducedMotion(), view: cameraViewRef.current },
        {
          onPick: (id) => {
            setSelectedId(id);
          },
          isBayTaken: (bay, exceptId) => {
            for (const [id, b] of stateRef.current.bays) {
              if (id !== exceptId && b.col === bay.col && b.row === bay.row) return true;
            }
            return false;
          },
          onDrop: (id, bay) => {
            const { bays: current, settings: s } = stateRef.current;
            const others = [...current].filter(([other]) => other !== id).map(([, b]) => b);
            const target = nearestFreeBay(bay, others, s.spotsPerRow, s.rows);
            if (target == null) return;
            const own = current.get(id);
            if (own != null && own.col === target.col && own.row === target.row) return;
            const position = bayToPosition(target);
            onMoveRef.current(id, position.x, position.y);
          },
          snapTransformer: (p) => snapTransformerToGrass(p.x, p.z, stateRef.current.settings),
          onTransformerDrop: (id, p) => {
            onTransformerMoveRef.current(id, p.x, p.z);
          },
          onBatteryDrop: (id, p) => {
            onEnergyAssetMoveRef.current?.(id, p.x, p.z);
          },
          onFrame: () => {
            const current = sceneRef.current;
            if (current == null) return;
            // Nearer station labels first, then the panels, the transformers and
            // the links; a label that would cover a placed one hides, so a dense
            // site stays readable.
            const placed: Rect[] = [];
            // A large site shows only the nearer labels (stationLabelInRange).
            const view = current.viewDistance();
            const count = stationCountRef.current;
            // Read every label size first, then write positions: no layout
            // read after a write within the frame (a 200-station site stays smooth).
            const sizes = new Map<HTMLElement, Size>();
            for (const refs of [
              avatarRefs.current,
              labelRefs.current,
              linkLabelRefs.current,
              transformerLabelRefs.current,
              energyLabelRefs.current,
            ]) {
              for (const el of refs.values()) {
                sizes.set(el, { width: el.offsetWidth, height: el.offsetHeight });
              }
            }
            const place = (el: HTMLElement, p: ScreenPoint | null): void => {
              placeLabel(el, p, placed, sizes.get(el));
            };
            // The nearer station labels first, then the driver avatars over the
            // charging cars: an avatar that would cover a label sits lower (on
            // the roof) or higher, else hides.
            const stationPoints = [...labelRefs.current]
              .map(([id, el]) => ({ el, p: current.labelPoint(id) }))
              .sort((a, b) => (a.p?.depth ?? 1) - (b.p?.depth ?? 1));
            for (const { el, p } of stationPoints) {
              place(el, p != null && stationLabelInRange(p.distance, view, count) ? p : null);
            }
            for (const [id, el] of avatarRefs.current) {
              const p = current.avatarPoint(id);
              const size = sizes.get(el) ?? { width: el.offsetWidth, height: el.offsetHeight };
              placeLabel(
                el,
                p != null && stationLabelInRange(p.distance, view, count) ? p : null,
                placed,
                size,
                [0, -(size.height + 2), -(size.height * 2 + 4), size.height + 4],
              );
            }
            // The panels (load management) before the transformers (information only).
            const linkEntries = [...linkLabelRefs.current];
            for (const [id, el] of linkEntries) {
              if (id.startsWith('panel:')) place(el, current.linkLabelPoint(id));
            }
            for (const [id, el] of transformerLabelRefs.current) {
              place(el, current.transformerLabelPoint(id));
            }
            for (const [id, el] of energyLabelRefs.current) {
              place(el, current.energyLabelPoint(id));
            }
            for (const [id, el] of linkEntries) {
              if (!id.startsWith('panel:')) place(el, current.linkLabelPoint(id));
            }
            const popup = popupRef.current;
            const selected = selectedRef.current;
            if (popup != null && selected != null && stage.clientWidth > 0) {
              const p = current.labelPoint(selected);
              if (p == null) return;
              placeLayoutPopup(
                popup,
                { left: p.x, right: p.x, top: p.y, bottom: p.y },
                { left: 0, top: 0, width: popupAreaWidth(stage), height: stage.clientHeight },
                18,
              );
            }
            const sessionPopup = sessionPopupRef.current;
            const sessionStation = sessionStationRef.current;
            if (sessionPopup != null && sessionStation != null && stage.clientWidth > 0) {
              const p = current.avatarPoint(sessionStation);
              if (p == null) return;
              placeLayoutPopup(
                sessionPopup,
                { left: p.x, right: p.x, top: p.y, bottom: p.y },
                { left: 0, top: 0, width: popupAreaWidth(stage), height: stage.clientHeight },
                24,
              );
            }
          },
        },
      );
    } catch {
      // fail-open: the browser refused a WebGL context, so the parent shows the 2D view with a note
      onUnavailableRef.current();
      return;
    }
    sceneRef.current = scene;
    scene.setTheme(readTheme(reservedLabelRef.current));
    scene.setLayout(sceneLayoutRef.current);
    scene.fit();
    // Rebuild the colors when the theme changes.
    const observer = new MutationObserver(() => {
      scene.setTheme(readTheme(reservedLabelRef.current));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    stateRef.current = { bays, settings };
    sceneLayoutRef.current = sceneLayout;
    sceneRef.current?.setLayout(sceneLayout);
  }, [sceneLayout, bays, settings]);

  useEffect(() => {
    sceneRef.current?.setLogo(logoUrl);
  }, [logoUrl]);

  useEffect(() => {
    stationCountRef.current = stations.length;
  }, [stations.length]);

  // Live power on the links: restyled in place, no rebuild.
  useEffect(() => {
    sceneRef.current?.setLinkFlow(flows?.segments ?? new Map<string, number>());
  }, [flows, sceneLayout]);

  useEffect(() => {
    onMoveRef.current = onMove;
    onTransformerMoveRef.current = onTransformerMove;
    onEnergyAssetMoveRef.current = onEnergyAssetMove;
  }, [onMove, onTransformerMove, onEnergyAssetMove]);

  // The Reserved sign follows the UI language.
  useEffect(() => {
    if (reservedLabelRef.current === reservedLabel) return;
    reservedLabelRef.current = reservedLabel;
    sceneRef.current?.setTheme(readTheme(reservedLabel));
  }, [reservedLabel]);

  useEffect(() => {
    sceneRef.current?.setEditing(editing);
    if (editing) {
      setSelectedId(null);
      setSessionStationId(null);
    }
  }, [editing]);

  useEffect(() => {
    selectedRef.current = selectedId;
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    sessionStationRef.current = sessionStationId;
  }, [sessionStationId]);

  useEffect(() => {
    listOpenRef.current = listOpen;
  }, [listOpen]);

  useEffect(() => {
    if (fitKey > 0) sceneRef.current?.fit();
  }, [fitKey]);

  useEffect(() => {
    sceneRef.current?.setActive(active && pageVisible);
  }, [active, pageVisible]);

  const selected = stations.find((s) => s.id === selectedId) ?? null;
  // Live markers (today only): the driver avatar over a charging car, the insight marker.
  const live = !replaying;
  const charging = live ? stations.filter((s) => stationDisplayState(s) === 'charging') : [];
  const sessionStation =
    sessionStationId == null
      ? null
      : (stations.find((s) => s.id === sessionStationId && s.session != null) ?? null);

  function openStation(id: string): void {
    setSessionStationId(null);
    setSelectedId(id);
  }

  function focusStation(id: string): void {
    sceneRef.current?.focus(id);
    openStation(id);
  }

  function focusState(state: SummaryState): void {
    const next = nextStationInState(stations, state, selectedId);
    if (next != null) focusStation(next);
  }

  return (
    <div
      ref={stageRef}
      data-testid="site-layout-3d"
      className={cn(
        'relative w-full overflow-clip rounded-lg border-2 border-dashed',
        stageClassName,
      )}
    >
      <div className="pointer-events-none absolute inset-0">
        {links.labels.map((label) => (
          <div
            key={label.id}
            ref={(el) => {
              if (el == null) linkLabelRefs.current.delete(label.id);
              else linkLabelRefs.current.set(label.id, el);
            }}
            data-testid={`site-layout-3d-link-${label.id}`}
            className={cn(
              'absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums shadow-xs',
              label.kind === 'station'
                ? 'border-primary/30 bg-card/85 text-muted-foreground'
                : 'border-primary/50 bg-card/90 text-foreground',
            )}
            style={{ left: 0, top: 0, visibility: 'hidden' }}
          >
            {linkLabelText(label)}
            {label.kind === 'panel' &&
              (() => {
                const load = flows?.loads.get(label.id.slice('panel:'.length));
                return load != null ? <PanelLoadBar load={load} /> : null;
              })()}
          </div>
        ))}
        {energyAssets.map((a) => (
          <div
            key={a.id}
            ref={(el) => {
              if (el == null) energyLabelRefs.current.delete(a.id);
              else energyLabelRefs.current.set(a.id, el);
            }}
            data-testid={`site-layout-3d-energy-${a.id}`}
            className="absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-card px-2 py-0.5 text-xs font-semibold shadow-xs"
            style={{ left: 0, top: 0, visibility: 'hidden' }}
          >
            {a.name ??
              (a.type === 'battery'
                ? t('sites.layoutView.battery')
                : t('sites.layoutView.solarCanopy'))}
            {a.type === 'battery' && a.capacityKwh != null && (
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                · {formatNumber(a.capacityKwh, 0)} kWh
              </span>
            )}
            {a.type === 'solar' && a.capacityKwp != null && (
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                · {formatNumber(a.capacityKwp, 0)} kWp
              </span>
            )}
          </div>
        ))}
        {transformers.map((tr) => (
          <div
            key={tr.id}
            ref={(el) => {
              if (el == null) transformerLabelRefs.current.delete(tr.id);
              else transformerLabelRefs.current.set(tr.id, el);
            }}
            data-testid={`site-layout-3d-transformer-${tr.id}`}
            className="absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-card px-2 py-0.5 text-xs font-semibold shadow-xs"
            style={{ left: 0, top: 0, visibility: 'hidden' }}
          >
            {tr.name ?? t('sites.layoutView.transformer')}
            {tr.ratedKva != null && (
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                · {formatNumber(tr.ratedKva, 0)} kVA
              </span>
            )}
          </div>
        ))}
        {stations.map((s) => {
          const state = stationDisplayState(s);
          const stateLabel = t(stationStateLabelKey(state));
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el == null) labelRefs.current.delete(s.id);
                else labelRefs.current.set(s.id, el);
              }}
              data-testid={`site-layout-3d-label-${s.id}`}
              className="absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 whitespace-nowrap text-xs font-semibold"
              style={{ left: 0, top: 0, visibility: 'hidden' }}
            >
              {/* The ID and state open the details too: keyboard access to every station. */}
              <Button
                type="button"
                variant="outline"
                size="chip"
                className={editing ? 'shadow-xs' : 'pointer-events-auto shadow-xs'}
                tabIndex={editing ? -1 : 0}
                aria-label={t('sites.layoutView.stateDetailsLabel', {
                  id: s.stationId,
                  state: stateLabel,
                })}
                onClick={() => {
                  if (!editing) setSelectedId(s.id);
                }}
              >
                <span>{s.stationId}</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span
                  data-testid="station-state-text"
                  data-state={state}
                  style={{ color: stationStateTextColor(state) }}
                >
                  {stateLabel}
                </span>
              </Button>
              {s.cellular && <CellularBadge />}
              {live &&
                (insights?.get(s.id) ?? []).slice(0, 1).map((insight) => (
                  <Link
                    key={insight.id}
                    to={insight.path}
                    data-testid={`site-layout-3d-insight-${s.id}`}
                    title={insight.headline}
                    aria-label={t('sites.layoutView.insightMarker', {
                      id: s.stationId,
                      headline: insight.headline,
                    })}
                    tabIndex={editing ? -1 : 0}
                    className={cn(
                      'inline-flex h-5 w-5 items-center justify-center rounded-full border border-link/40 bg-card text-link shadow-xs',
                      editing ? '' : 'pointer-events-auto',
                    )}
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                  </Link>
                ))}
            </div>
          );
        })}
        {charging.map((s) => {
          const session = s.session ?? null;
          const driver = session?.driver ?? null;
          const names = splitDriverName(driver?.name ?? null);
          return (
            <div
              key={`avatar-${s.id}`}
              ref={(el) => {
                if (el == null) avatarRefs.current.delete(s.id);
                else avatarRefs.current.set(s.id, el);
              }}
              data-testid={`site-layout-3d-avatar-${s.id}`}
              className="absolute -translate-x-1/2 -translate-y-full"
              style={{ left: 0, top: 0, visibility: 'hidden' }}
            >
              {session == null ? (
                // Without sessions:read: a plain marker, no session or driver data.
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-muted text-muted-foreground shadow-sm"
                >
                  <User className="h-4 w-4" />
                </span>
              ) : (
                <button
                  type="button"
                  className={cn(
                    'flex rounded-full border-2 border-card shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    editing ? '' : 'pointer-events-auto',
                  )}
                  tabIndex={editing ? -1 : 0}
                  aria-label={
                    driver?.name != null
                      ? t('sites.layoutView.sessionOfDriver', {
                          id: s.stationId,
                          name: driver.name,
                        })
                      : t('sites.layoutView.sessionDetailsLabel', { id: s.stationId })
                  }
                  onClick={() => {
                    if (editing) return;
                    setSelectedId(null);
                    setSessionStationId(s.id);
                  }}
                >
                  {driver != null ? (
                    <AccountAvatar
                      avatar={driver.avatar}
                      firstName={names.first}
                      lastName={names.last}
                      size="sm"
                    />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <User className="h-4 w-4" aria-hidden="true" />
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!editing && (
        <div className="pointer-events-none absolute left-3 top-3 right-14">
          <LayoutSummaryChip stations={stations} onFocusState={focusState} />
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="absolute right-3 top-3 bg-card shadow-xs"
        aria-pressed={listOpen}
        aria-label={listOpen ? t('sites.layoutView.hideList') : t('sites.layoutView.showList')}
        title={listOpen ? t('sites.layoutView.hideList') : t('sites.layoutView.showList')}
        data-testid="site-layout-list-toggle"
        onClick={() => {
          setListOpen((o) => !o);
        }}
      >
        {listOpen ? <X className="h-4 w-4" /> : <List className="h-4 w-4" />}
      </Button>
      {listOpen && (
        <div
          className="absolute bottom-14 right-3 top-12 z-[900] w-64 max-w-[calc(100%-24px)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border bg-card/95 p-2 shadow-lg backdrop-blur-xs"
          data-testid="site-layout-list-panel"
        >
          <LayoutStationList
            stations={stations}
            currentDrawKw={currentDrawKw}
            selectedId={selectedId}
            onSelect={(id) => {
              if (editing) return;
              focusStation(id);
            }}
          />
        </div>
      )}
      <p className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-24px)] rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
        {editing
          ? t('sites.layoutView.hintEdit')
          : replaying
            ? t('sites.layoutView.hintReplay')
            : viewOnly
              ? t('sites.layoutView.hintViewOnly')
              : t('sites.layoutView.hint')}
      </p>
      {sessionStation?.session != null && !editing && live && (
        <SessionLayoutPopup
          ref={sessionPopupRef}
          session={sessionStation.session}
          stationLabel={sessionStation.stationId}
          stationId={sessionStation.id}
          onClose={() => {
            setSessionStationId(null);
          }}
        />
      )}
      {selected != null && !editing && (
        <StationLayoutPopup
          ref={popupRef}
          station={selected}
          currentDrawKw={currentDrawKw(selected.id)}
          allocatedLimitKw={allocatedLimitKw(selected.id)}
          terminals={terminals.get(selected.id)}
          onClose={() => {
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}
