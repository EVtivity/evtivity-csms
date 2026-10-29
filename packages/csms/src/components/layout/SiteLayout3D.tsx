// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 3D view of the site Layout tab. SiteLayout loads it with React.lazy, so
// three.js (site-layout-scene.ts) is fetched only when the 3D view shows.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assignBays,
  bayToPosition,
  nearestFreeBay,
  positionToBay,
  type LayoutBay,
} from '@evtivity/lib/site-layout';
import {
  resolveCssColor,
  stationDisplayState,
  stationStateColor,
} from '@/lib/station-display-state';
import { Button } from '@/components/ui/button';
import {
  createSiteScene,
  type SceneStation,
  type ScreenPoint,
  type SiteScene,
} from './site-layout-scene';
import type { LayoutStation } from './StationCard';
import { StationLayoutPopup } from './StationLayoutPopup';
import { CellularBadge, NewPlacementTag, StationStateIcon } from './StationStateIcon';

export interface SiteLayout3DProps {
  stations: readonly LayoutStation[];
  /** Edit mode: drag stations to free bays (only with sites:write). */
  editing: boolean;
  /** Bumped by Fit to View. */
  fitKey: number;
  currentDrawKw: (stationId: string) => number | undefined;
  onMove: (stationId: string, x: number, y: number) => void;
  /** The browser could not create a WebGL context: the parent shows the 2D view. */
  onUnavailable: () => void;
}

/** The lot size for these bays: at least 5 by 2, plus one free row below the last station. */
export function lotSize(bays: readonly LayoutBay[]): { cols: number; rows: number } {
  const cols = Math.max(5, ...bays.map((b) => b.col + 1));
  const rows = Math.max(2, ...bays.map((b) => b.row + 2));
  return { cols, rows };
}

/** The bay of every station: its 2D slot, or the nearest free bay when another holds it. */
export function stationBays(stations: readonly LayoutStation[]): {
  bays: Map<string, LayoutBay>;
  cols: number;
  rows: number;
} {
  const cols = Math.max(
    5,
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
  return { bays, ...lotSize(assigned) };
}

function readTheme() {
  return {
    dark: document.documentElement.classList.contains('dark'),
    background: resolveCssColor('hsl(var(--background))'),
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

export default function SiteLayout3D({
  stations,
  editing,
  fitKey,
  currentDrawKw,
  onMove,
  onUnavailable,
}: SiteLayout3DProps): React.JSX.Element {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SiteScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const popupRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const layout = useMemo(() => stationBays(stations), [stations]);
  const layoutRef = useRef(layout);
  const onMoveRef = useRef(onMove);
  const onUnavailableRef = useRef(onUnavailable);

  const sceneStations = useMemo<SceneStation[]>(
    () =>
      stations.map((s) => {
        const state = stationDisplayState(s);
        return {
          id: s.id,
          kind: s.chargingKind,
          bay: layout.bays.get(s.id) ?? { col: 0, row: 0 },
          lightColor: resolveCssColor(stationStateColor(state)),
          lit: state !== 'offline',
          pulsing: state === 'charging',
        };
      }),
    [stations, layout],
  );
  const sceneStationsRef = useRef(sceneStations);

  // Create the scene once; the effects below feed it.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;
    let scene: SiteScene;
    try {
      scene = createSiteScene(
        stage,
        { reducedMotion: prefersReducedMotion() },
        {
          onPick: (id) => {
            setSelectedId(id);
          },
          isBayTaken: (bay, exceptId) => {
            for (const [id, b] of layoutRef.current.bays) {
              if (id !== exceptId && b.col === bay.col && b.row === bay.row) return true;
            }
            return false;
          },
          onDrop: (id, bay) => {
            const { bays, cols, rows } = layoutRef.current;
            const others = [...bays].filter(([other]) => other !== id).map(([, b]) => b);
            const target = nearestFreeBay(bay, others, cols, rows);
            if (target == null) return;
            const own = bays.get(id);
            if (own != null && own.col === target.col && own.row === target.row) return;
            const position = bayToPosition(target);
            onMoveRef.current(id, position.x, position.y);
          },
          onFrame: () => {
            const current = sceneRef.current;
            if (current == null) return;
            // Nearer labels first; a label that would cover a nearer one hides, so
            // a dense site stays readable (click the model, or zoom in).
            const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
            const points = [...labelRefs.current]
              .map(([id, el]) => ({ el, p: current.labelPoint(id) }))
              .filter((e): e is { el: HTMLDivElement; p: ScreenPoint } => e.p != null)
              .sort((a, b) => a.p.depth - b.p.depth);
            for (const { el, p } of points) {
              // Above the model, else one row higher, else hidden.
              let shown = false;
              for (const lift of [0, el.offsetHeight + 4]) {
                const y = p.y - lift;
                const box = {
                  left: p.x - el.offsetWidth / 2,
                  right: p.x + el.offsetWidth / 2,
                  top: y - el.offsetHeight,
                  bottom: y,
                };
                const covers = placed.some(
                  (o) =>
                    box.left < o.right &&
                    o.left < box.right &&
                    box.top < o.bottom &&
                    o.top < box.bottom,
                );
                if (p.visible && !covers) {
                  placed.push(box);
                  el.style.left = `${String(p.x)}px`;
                  el.style.top = `${String(y)}px`;
                  shown = true;
                  break;
                }
              }
              el.style.visibility = shown ? 'visible' : 'hidden';
            }
            const popup = popupRef.current;
            const selected = selectedRef.current;
            if (popup != null && selected != null && stage.clientWidth > 0) {
              const p = current.labelPoint(selected);
              if (p == null) return;
              const width = popup.offsetWidth;
              const height = popup.offsetHeight;
              let left = p.x + 18;
              if (left + width > stage.clientWidth - 12) left = p.x - width - 18;
              left = Math.max(12, Math.min(left, stage.clientWidth - width - 12));
              const top = Math.max(
                12,
                Math.min(p.y - height / 2, stage.clientHeight - height - 12),
              );
              popup.style.left = `${String(left)}px`;
              popup.style.top = `${String(top)}px`;
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
    scene.setTheme(readTheme());
    scene.setStations(sceneStationsRef.current, layoutRef.current.cols, layoutRef.current.rows);
    scene.fit();
    // Rebuild the colors when the theme changes.
    const observer = new MutationObserver(() => {
      scene.setTheme(readTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    layoutRef.current = layout;
    sceneStationsRef.current = sceneStations;
    sceneRef.current?.setStations(sceneStations, layout.cols, layout.rows);
  }, [sceneStations, layout]);

  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

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
    if (selectedId == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [selectedId]);

  const selected = stations.find((s) => s.id === selectedId) ?? null;

  return (
    <div
      ref={stageRef}
      data-testid="site-layout-3d"
      className="relative h-[420px] w-full overflow-hidden rounded-lg border-2 border-dashed sm:h-[580px]"
    >
      <div className="pointer-events-none absolute inset-0">
        {stations.map((s) => (
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
            {/* The ID opens the details too: keyboard access to every station. */}
            <Button
              type="button"
              variant="outline"
              size="chip"
              className={editing ? 'shadow-xs' : 'pointer-events-auto shadow-xs'}
              tabIndex={editing ? -1 : 0}
              aria-label={t('sites.layoutView.detailsLabel', { id: s.stationId })}
              onClick={() => {
                if (!editing) setSelectedId(s.id);
              }}
            >
              {s.stationId}
            </Button>
            <span className="rounded-full border bg-card p-0.5 shadow-xs">
              <StationStateIcon state={stationDisplayState(s)} />
            </span>
            {s.cellular && <CellularBadge />}
            {!s.placed && <NewPlacementTag />}
          </div>
        ))}
      </div>
      <p className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-24px)] rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
        {editing ? t('sites.layoutView.hintEdit') : t('sites.layoutView.hint')}
      </p>
      {selected != null && !editing && (
        <StationLayoutPopup
          ref={popupRef}
          station={selected}
          currentDrawKw={currentDrawKw(selected.id)}
          onClose={() => {
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}
