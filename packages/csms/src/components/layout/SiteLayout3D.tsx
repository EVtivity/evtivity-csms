// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 3D view of the site Layout tab and of the dashboard Site Layout widget
// (view only). Both load it with React.lazy, so three.js
// (site-layout-scene.ts) is fetched only when a 3D view shows.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assignBays,
  bayToPosition,
  nearestFreeBay,
  positionToBay,
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
import { lotOf, stationBackPoint, stationProp, type Point } from './site-layout-grid';
import { loadLinks, type LinkLabel, type LinkPanel } from './site-layout-links';
import { terminalSide, type LayoutTerminal } from './layout-terminals';
import { StationLayoutPopup } from './StationLayoutPopup';
import { placeLayoutPopup } from './layout-popup-position';
import { STAGE_HEIGHT_CLASS } from './site-layout-stage';
import { cn } from '@/lib/utils';
import { CellularBadge } from './StationStateIcon';

export interface SiteLayout3DProps {
  stations: readonly LayoutStation[];
  /** The lot and the transformers (effective settings, pending edits included). */
  settings: SiteLayoutSettings;
  /** Payment terminals paired to each station (by internal station ID). */
  terminals: ReadonlyMap<string, readonly LayoutTerminal[]>;
  /** The load management hierarchy when the site is load managed, else null (no links). */
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
  /** The browser could not create a WebGL context: the parent shows the 2D view. */
  onUnavailable: () => void;
  /** Where Fit to View puts the camera (default `overview`). */
  cameraView?: SceneCameraView;
  /** The stage height classes (default: the Layout tab stage). */
  stageClassName?: string;
  /** Renders while true (default); false pauses the frame loop (off screen, hidden tab). */
  active?: boolean;
  /** View only (the dashboard): the hint names no editing. Pass `editing` false too. */
  viewOnly?: boolean;
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

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** Places one overlay label above its point (or one row higher) where it covers no placed label. */
function placeLabel(el: HTMLElement, p: ScreenPoint | null, placed: Rect[]): void {
  let shown = false;
  if (p != null && p.visible) {
    for (const lift of [0, el.offsetHeight + 4]) {
      const y = p.y - lift;
      const rect = {
        left: p.x - el.offsetWidth / 2,
        right: p.x + el.offsetWidth / 2,
        top: y - el.offsetHeight,
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
  onUnavailable,
  cameraView = 'overview',
  stageClassName = STAGE_HEIGHT_CLASS,
  active = true,
  viewOnly = false,
}: SiteLayout3DProps): React.JSX.Element {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SiteScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const transformerLabelRefs = useRef(new Map<string, HTMLDivElement>());
  const linkLabelRefs = useRef(new Map<string, HTMLDivElement>());
  const popupRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const lot = useMemo(() => lotOf(settings), [settings]);
  const bays = useMemo(() => stationBays(stations, settings), [stations, settings]);
  const links = useMemo(() => {
    if (hierarchy == null) return { segments: [], labels: [] };
    const points = new Map<string, Point>();
    for (const [id, bay] of bays) points.set(id, stationBackPoint(bay, lot));
    return loadLinks(
      hierarchy,
      settings.transformers.map((tr) => ({ x: tr.x, z: tr.z, ratedKva: tr.ratedKva })),
      points,
    );
  }, [hierarchy, bays, lot, settings.transformers]);

  const stateRef = useRef({ bays, settings });
  const onMoveRef = useRef(onMove);
  const onTransformerMoveRef = useRef(onTransformerMove);
  const onUnavailableRef = useRef(onUnavailable);
  const reservedLabel = t('sites.layoutState.reserved');
  const reservedLabelRef = useRef(reservedLabel);

  const sceneLayout = useMemo(() => {
    const sceneStations: SceneStation[] = stations.map((s) => {
      const state = stationDisplayState(s);
      return {
        id: s.id,
        kind: s.chargingKind,
        bay: bays.get(s.id) ?? { col: 0, row: 0 },
        lightColor: resolveCssColor(stationStateColor(state)),
        lit: state !== 'offline',
        pulsing: state === 'charging',
        prop: stationProp(state),
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
      transformers: settings.transformers.map((tr) => ({ id: tr.id, x: tr.x, z: tr.z })),
      links,
    };
  }, [stations, bays, lot, settings.transformers, terminals, links]);
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
          onFrame: () => {
            const current = sceneRef.current;
            if (current == null) return;
            // Nearer station labels first, then transformers, then the links; a
            // label that would cover a placed one hides, so a dense site stays readable.
            const placed: Rect[] = [];
            const stationPoints = [...labelRefs.current]
              .map(([id, el]) => ({ el, p: current.labelPoint(id) }))
              .sort((a, b) => (a.p?.depth ?? 1) - (b.p?.depth ?? 1));
            for (const { el, p } of stationPoints) placeLabel(el, p, placed);
            for (const [id, el] of transformerLabelRefs.current) {
              placeLabel(el, current.transformerLabelPoint(id), placed);
            }
            for (const [id, el] of linkLabelRefs.current) {
              placeLabel(el, current.linkLabelPoint(id), placed);
            }
            const popup = popupRef.current;
            const selected = selectedRef.current;
            if (popup != null && selected != null && stage.clientWidth > 0) {
              const p = current.labelPoint(selected);
              if (p == null) return;
              placeLayoutPopup(
                popup,
                { left: p.x, right: p.x, top: p.y, bottom: p.y },
                { left: 0, top: 0, width: stage.clientWidth, height: stage.clientHeight },
                18,
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
    onMoveRef.current = onMove;
    onTransformerMoveRef.current = onTransformerMove;
  }, [onMove, onTransformerMove]);

  // The Reserved sign follows the UI language.
  useEffect(() => {
    if (reservedLabelRef.current === reservedLabel) return;
    reservedLabelRef.current = reservedLabel;
    sceneRef.current?.setTheme(readTheme(reservedLabel));
  }, [reservedLabel]);

  useEffect(() => {
    sceneRef.current?.setEditing(editing);
    if (editing) setSelectedId(null);
  }, [editing]);

  useEffect(() => {
    selectedRef.current = selectedId;
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (fitKey > 0) sceneRef.current?.fit();
  }, [fitKey]);

  useEffect(() => {
    sceneRef.current?.setActive(active);
  }, [active]);

  const selected = stations.find((s) => s.id === selectedId) ?? null;

  return (
    <div
      ref={stageRef}
      data-testid="site-layout-3d"
      className={cn(
        'relative w-full overflow-hidden rounded-lg border-2 border-dashed',
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
          </div>
        ))}
        {settings.transformers.map((tr) => (
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
            </div>
          );
        })}
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-24px)] rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
        {editing
          ? t('sites.layoutView.hintEdit')
          : viewOnly
            ? t('sites.layoutView.hintViewOnly')
            : t('sites.layoutView.hint')}
      </p>
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
