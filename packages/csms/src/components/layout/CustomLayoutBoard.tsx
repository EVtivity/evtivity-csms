// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 2D view of a custom site: every station's parking spots from above at
// its free position and turn (the same positions as the 3D view), with the
// standard 2D charger card of every site type at its charger
// (`PlacedStationCard`, never a chip). A station drags freely by its card
// (snapped to 0.5 m, refused over another station's spots); with its card
// focused, the arrow keys move it and R turns it (Shift+R by 1 degree).

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  freeFootprint,
  freeFootprintsOverlap,
  freeSpotRects,
  freeStationsBox,
  freeToSite,
  snapFreePlacement,
  type FreePlacement,
  LAYOUT_CARD_HEIGHT,
  LAYOUT_CARD_WIDTH,
} from '@evtivity/lib/site-layout';
import { cn } from '@/lib/utils';
import { PlacedStationCard, type LayoutStation } from './StationCard';
import type { FreeStationPlace } from './site-layout-free';

/** Pixels per meter of the 2D custom board. */
export const CUSTOM_BOARD_PX_PER_M = 30;
/** Grass around the stations, in meters. */
const BOARD_MARGIN_M = 4;

export interface CustomBoardGeometry {
  /** The site point at the board's top left corner, in meters. */
  originX: number;
  originZ: number;
  width: number;
  height: number;
}

/** The board around every station's spots, with a margin, at CUSTOM_BOARD_PX_PER_M. */
export function customBoardGeometry(places: readonly FreeStationPlace[]): CustomBoardGeometry {
  const box = freeStationsBox(places) ?? { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  const s = CUSTOM_BOARD_PX_PER_M;
  return {
    originX: box.minX - BOARD_MARGIN_M,
    originZ: box.minZ - BOARD_MARGIN_M,
    width: Math.ceil((box.maxX - box.minX + 2 * BOARD_MARGIN_M) * s),
    height: Math.ceil((box.maxZ - box.minZ + 2 * BOARD_MARGIN_M) * s),
  };
}

/** A site point on the board, in px. */
export function boardPoint(
  g: CustomBoardGeometry,
  p: { x: number; z: number },
): {
  x: number;
  y: number;
} {
  const s = CUSTOM_BOARD_PX_PER_M;
  return { x: (p.x - g.originX) * s, y: (p.z - g.originZ) * s };
}

interface CustomLayoutBoardProps {
  stations: readonly LayoutStation[];
  places: ReadonlyMap<string, FreeStationPlace>;
  onMove: (stationId: string, placement: FreePlacement) => void;
  onOpenDetails: (stationId: string) => void;
  /** The board element (the popup places itself inside it). */
  boardRef: React.RefObject<HTMLDivElement | null>;
  /** The live draw and allocated limit of a station (the card shows them). */
  power?: ReadonlyMap<string, { currentDrawKw: number; allocatedLimitKw: number | null }>;
  children?: React.ReactNode;
}

/**
 * Where the standard card of each station stands, its middle in board px: at
 * the station's charger point, and, where that would cover an earlier card,
 * moved down (else up) by whole card heights until it covers none, so no
 * card hides another (owner decision 2026-11-01: one 2D charger card for every
 * site type).
 */
export function customCardPositions(
  stations: ReadonlyArray<Pick<LayoutStation, 'id'>>,
  places: ReadonlyMap<string, FreeStationPlace>,
  geometry: CustomBoardGeometry,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const placed: Array<{ x: number; y: number }> = [];
  const gap = 8;
  const hits = (p: { x: number; y: number }): boolean =>
    placed.some(
      (o) =>
        Math.abs(o.x - p.x) < LAYOUT_CARD_WIDTH + gap &&
        Math.abs(o.y - p.y) < LAYOUT_CARD_HEIGHT + gap,
    );
  for (const station of stations) {
    const place = places.get(station.id);
    if (place == null) continue;
    const base = boardPoint(geometry, place.placement);
    let at = base;
    for (let k = 1; k <= 40 && hits(at); k++) {
      const step = Math.ceil(k / 2) * (LAYOUT_CARD_HEIGHT + gap) * (k % 2 === 1 ? 1 : -1);
      at = { x: base.x, y: base.y + step };
    }
    placed.push(at);
    out.set(station.id, at);
  }
  return out;
}

export function CustomLayoutBoard({
  stations,
  places,
  onMove,
  onOpenDetails,
  boardRef,
  power,
  children,
}: CustomLayoutBoardProps): React.JSX.Element {
  const { t } = useTranslation();
  // The board stays put while a station is dragged (it grows after the drop).
  const geometry = customBoardGeometry([...places.values()]);
  const [drag, setDrag] = useState<{ id: string; placement: FreePlacement } | null>(null);
  // The standard card of each station at its charger point, moved off any card before it.
  const cardAt = customCardPositions(stations, places, geometry);
  const [notice, setNotice] = useState<string | null>(null);
  const s = CUSTOM_BOARD_PX_PER_M;
  // The board opens on the middle of the stations (a wide site is larger than a phone).
  const centered = useRef(false);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (board == null || centered.current || places.size === 0) return;
    centered.current = true;
    board.scrollLeft = Math.max(0, (geometry.width - board.clientWidth) / 2);
    board.scrollTop = Math.max(0, (geometry.height - board.clientHeight) / 2);
  });

  function blocked(id: string, moved: FreePlacement): boolean {
    const own = places.get(id);
    return [...places].some(
      ([other, o]) =>
        other !== id && freeFootprintsOverlap({ placement: moved, spots: own?.spots ?? 1 }, o),
    );
  }

  function commit(id: string, placement: FreePlacement): void {
    const name = stations.find((st) => st.id === id)?.stationId ?? id;
    if (blocked(id, placement)) {
      setNotice(t('sites.layoutView.spotsOverlap', { id: name }));
      return;
    }
    setNotice(null);
    onMove(id, placement);
  }

  function onKeyDown(e: React.KeyboardEvent, id: string): void {
    const own = places.get(id);
    if (own == null) return;
    const step = 0.5;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = move[e.key];
    const turn = e.key === 'r' || e.key === 'R' ? (e.shiftKey ? 1 : 15) : 0;
    if (delta == null && turn === 0) return;
    e.preventDefault();
    const p = own.placement;
    const next = {
      x: p.x + (delta?.[0] ?? 0),
      z: p.z + (delta?.[1] ?? 0),
      rotationDeg: p.rotationDeg + turn,
    };
    commit(id, snapFreePlacement(next, { freeRotation: turn !== 15 }));
  }

  return (
    <div
      ref={boardRef}
      data-testid="site-layout-2d"
      className="relative h-[700px] w-full overflow-auto rounded-lg border-2 border-dashed"
    >
      <div className="relative" style={{ width: geometry.width, height: geometry.height }}>
        <svg
          aria-hidden="true"
          className="absolute inset-0"
          width={geometry.width}
          height={geometry.height}
          data-testid="site-layout-2d-custom"
        >
          {stations.map((station) => {
            const place = places.get(station.id);
            if (place == null) return null;
            const placement = drag?.id === station.id ? drag.placement : place.placement;
            const corners = freeFootprint(placement, place.spots).map((c) =>
              boardPoint(geometry, c),
            );
            // A line between two car spots.
            const rects = freeSpotRects(place.spots);
            const at = (x: number, z: number) => boardPoint(geometry, freeToSite(placement, x, z));
            const lines: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
            rects.forEach((r, i) => {
              if (i > 0) lines.push([at(r.minX, r.minZ), at(r.minX, r.maxZ)]);
            });
            const isBlocked = drag?.id === station.id && blocked(station.id, placement);
            return (
              <g key={station.id} data-testid={`site-layout-2d-spots-${station.id}`}>
                <polygon
                  points={corners.map((c) => `${String(c.x)},${String(c.y)}`).join(' ')}
                  className={cn(
                    'fill-muted/70 stroke-primary/60',
                    isBlocked && 'fill-destructive/20 stroke-destructive',
                  )}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                {lines.map(([a, b], i) => (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className="stroke-primary/60"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ))}
              </g>
            );
          })}
        </svg>
        {stations.map((station) => {
          const place = places.get(station.id);
          const home = cardAt.get(station.id);
          if (place == null || home == null) return null;
          // While dragged, the card follows the station's charger point.
          const dragged = drag?.id === station.id ? boardPoint(geometry, drag.placement) : null;
          const own = boardPoint(geometry, place.placement);
          const at =
            dragged != null
              ? { x: home.x + dragged.x - own.x, y: home.y + dragged.y - own.y }
              : home;
          const p = power?.get(station.id);
          return (
            <PlacedStationCard
              key={station.id}
              station={station}
              left={at.x}
              top={at.y}
              centered
              draggable
              dragging={drag?.id === station.id}
              currentDrawKw={p?.currentDrawKw}
              allocatedLimitKw={p?.allocatedLimitKw}
              onOpenDetails={onOpenDetails}
              onKeyDown={(e) => {
                onKeyDown(e, station.id);
              }}
              onDragMove={(dx, dy) => {
                setDrag({
                  id: station.id,
                  placement: snapFreePlacement(
                    {
                      ...place.placement,
                      x: place.placement.x + dx / s,
                      z: place.placement.z + dy / s,
                    },
                    { freeRotation: true },
                  ),
                });
              }}
              onDragEnd={(moved) => {
                const last = drag;
                setDrag(null);
                if (moved && last != null && last.id === station.id)
                  commit(station.id, last.placement);
              }}
            />
          );
        })}
        {children}
      </div>
      {notice != null && (
        <p
          role="alert"
          data-testid="site-layout-2d-notice"
          className="sticky bottom-3 left-3 m-3 inline-block rounded-md border border-destructive/50 bg-card px-2.5 py-1.5 text-xs text-destructive shadow-sm"
        >
          {notice}
        </p>
      )}
    </div>
  );
}
